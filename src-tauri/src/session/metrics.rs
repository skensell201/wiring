use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};

use kube::api::{Api, DynamicObject, ListParams};
use kube::core::{ApiResource, GroupVersionKind};
use kube::Client;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::emitter::{Emitter, OutEvent};
use super::reducer::ReducerMsg;
use super::shared::Shared;
use crate::metrics::sample::parse_pod_metrics;
use crate::metrics::{MetricsSample, MetricsState, MetricsUpdate};

/// metrics-server scrapes every 15 s; polling faster only repeats the same sample.
pub const POLL_PERIOD: Duration = Duration::from_secs(15);

/// Consecutive transient failures, before any sample, after which the poller says metrics-server
/// is not responding (a registered but unhealthy server answers 503 forever).
const UNRESPONSIVE_AFTER: u32 = 3;

/// What one poll means for the sample.
#[derive(Debug, PartialEq)]
pub enum Outcome {
    Sample(Vec<Value>),
    /// 404: the Metrics API is not served (no metrics-server).
    Unavailable,
    /// 403: RBAC forbids `pods.metrics.k8s.io`.
    Forbidden,
    /// Anything else: keep the last sample and try again next tick.
    Transient,
}

pub fn classify(result: Result<Vec<Value>, kube::Error>) -> Outcome {
    match result {
        Ok(items) => Outcome::Sample(items),
        Err(kube::Error::Api(s)) if s.code == 404 => Outcome::Unavailable,
        Err(kube::Error::Api(s)) if s.code == 403 => Outcome::Forbidden,
        Err(_) => Outcome::Transient,
    }
}

/// Poll with `fetch` every `period`, the first time at once, until the API turns out missing or
/// forbidden. Each answer replaces the store's sample, asks the reducer to rebuild (usage badges
/// live in the graph) and tells the frontend (table cells and Overview rows are fetched on demand).
pub async fn run<F, Fut>(mut fetch: F, shared: Shared, reducer: mpsc::Sender<ReducerMsg>, emitter: Arc<dyn Emitter>, period: Duration)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<Vec<Value>, kube::Error>>,
{
    let mut ticker = tokio::time::interval(period);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut failures = 0u32;
    loop {
        ticker.tick().await;
        let (state, done) = match classify(fetch().await) {
            Outcome::Sample(items) => {
                let pods = parse_pod_metrics(&items);
                failures = 0;
                shared.store().metrics = MetricsSample {
                    state: MetricsState::Available,
                    pods,
                    sampled_at: Some(Instant::now()),
                    ..Default::default()
                };
                (MetricsState::Available, false)
            }
            Outcome::Unavailable => (end(&shared, MetricsState::Unavailable), true),
            Outcome::Forbidden => (end(&shared, MetricsState::Forbidden), true),
            Outcome::Transient => {
                failures += 1;
                // Report it once, and only while there is no sample to keep showing; polling goes
                // on, and a sample turns the state back to `Available`.
                let silent = failures != UNRESPONSIVE_AFTER || shared.store().metrics.state == MetricsState::Available;
                if silent {
                    continue;
                }
                {
                    let mut store = shared.store();
                    store.metrics.state = MetricsState::Unavailable;
                    store.metrics.unresponsive = true;
                }
                (MetricsState::Unavailable, false)
            }
        };
        if reducer.send(ReducerMsg::Rebuild).await.is_err() {
            return; // the namespace session is gone
        }
        emitter.emit(OutEvent::MetricsUpdated(MetricsUpdate { state }));
        if done {
            return;
        }
    }
}

/// Record a final state with no usage; returns it for the event.
fn end(shared: &Shared, state: MetricsState) -> MetricsState {
    shared.store().metrics = MetricsSample {
        state,
        ..Default::default()
    };
    state
}

/// The live poller for `namespace`. It is pushed to the namespace session's tasks, so a
/// namespace switch or disconnect aborts it with the watchers.
pub fn spawn(
    client: Client,
    namespace: &str,
    shared: Shared,
    reducer: mpsc::Sender<ReducerMsg>,
    emitter: Arc<dyn Emitter>,
) -> JoinHandle<()> {
    let ar = ApiResource::from_gvk_with_plural(&GroupVersionKind::gvk("metrics.k8s.io", "v1beta1", "PodMetrics"), "pods");
    let api: Api<DynamicObject> = Api::namespaced_with(client, namespace, &ar);
    tokio::spawn(run(
        move || {
            let api = api.clone();
            async move {
                let list = api.list(&ListParams::default()).await?;
                Ok(list.items.into_iter().filter_map(|o| serde_json::to_value(o).ok()).collect())
            }
        },
        shared,
        reducer,
        emitter,
        POLL_PERIOD,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metrics::PodUsage;
    use crate::session::emitter::ChannelEmitter;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};

    /// Receive with a deadline, so a regression fails the test instead of hanging it.
    async fn next(rx: &mut mpsc::Receiver<ReducerMsg>) -> Option<ReducerMsg> {
        tokio::time::timeout(Duration::from_secs(60), rx.recv())
            .await
            .expect("a message arrives")
    }

    async fn next_event(rx: &mut mpsc::UnboundedReceiver<OutEvent>) -> Option<OutEvent> {
        tokio::time::timeout(Duration::from_secs(60), rx.recv())
            .await
            .expect("an event arrives")
    }

    fn api_error(code: u16) -> kube::Error {
        kube::Error::Api(Box::new(kube::core::Status::failure("x", "x").with_code(code)))
    }

    fn item() -> Value {
        json!({ "metadata": { "name": "a" }, "containers": [ { "name": "c", "usage": { "cpu": "250m", "memory": "64Mi" } } ] })
    }

    #[test]
    fn errors_are_classified() {
        assert_eq!(classify(Ok(vec![item()])), Outcome::Sample(vec![item()]));
        assert_eq!(classify(Err(api_error(404))), Outcome::Unavailable);
        assert_eq!(classify(Err(api_error(403))), Outcome::Forbidden);
        assert_eq!(classify(Err(api_error(500))), Outcome::Transient);
    }

    #[tokio::test(start_paused = true)]
    async fn a_sample_lands_in_the_store_rebuilds_and_is_announced_every_period() {
        let shared = Shared::default();
        let (tx, mut reducer) = mpsc::channel(8);
        let (emitter, mut events) = ChannelEmitter::new();
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();
        let task = tokio::spawn(run(
            move || {
                c.fetch_add(1, SeqCst);
                async { Ok(vec![item()]) }
            },
            shared.clone(),
            tx,
            Arc::new(emitter),
            Duration::from_secs(15),
        ));
        assert!(matches!(next(&mut reducer).await, Some(ReducerMsg::Rebuild)));
        assert_eq!(
            events.recv().await,
            Some(OutEvent::MetricsUpdated(MetricsUpdate {
                state: MetricsState::Available
            }))
        );
        assert_eq!(shared.store().metrics.state, MetricsState::Available);
        assert_eq!(
            shared.store().metrics.pods["a"],
            PodUsage {
                cpu_millis: 250,
                memory_bytes: 64 << 20
            }
        );
        tokio::time::advance(Duration::from_secs(15)).await;
        assert!(matches!(next(&mut reducer).await, Some(ReducerMsg::Rebuild)));
        assert_eq!(calls.load(SeqCst), 2);
        task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn a_missing_or_forbidden_api_ends_polling_with_its_state() {
        for (code, state) in [(404, MetricsState::Unavailable), (403, MetricsState::Forbidden)] {
            let shared = Shared::default();
            shared.store().metrics.pods.insert("old".into(), PodUsage::default());
            let (tx, mut reducer) = mpsc::channel(8);
            let (emitter, mut events) = ChannelEmitter::new();
            let calls = Arc::new(AtomicUsize::new(0));
            let c = calls.clone();
            let task = tokio::spawn(run(
                move || {
                    c.fetch_add(1, SeqCst);
                    async move { Err(api_error(code)) }
                },
                shared.clone(),
                tx,
                Arc::new(emitter),
                Duration::from_secs(15),
            ));
            assert!(matches!(next(&mut reducer).await, Some(ReducerMsg::Rebuild)));
            assert_eq!(
                next_event(&mut events).await,
                Some(OutEvent::MetricsUpdated(MetricsUpdate { state }))
            );
            tokio::time::timeout(Duration::from_secs(60), task)
                .await
                .expect("the poller stops")
                .unwrap();
            assert_eq!(calls.load(SeqCst), 1);
            assert_eq!(shared.store().metrics.state, state);
            assert!(shared.store().metrics.pods.is_empty());
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_transient_error_keeps_the_last_sample_and_retries() {
        let shared = Shared::default();
        {
            let mut store = shared.store();
            store.metrics.state = MetricsState::Available;
            store.metrics.pods.insert(
                "old".into(),
                PodUsage {
                    cpu_millis: 1,
                    memory_bytes: 1,
                },
            );
        }
        let (tx, mut reducer) = mpsc::channel(8);
        let (emitter, mut events) = ChannelEmitter::new();
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();
        let task = tokio::spawn(run(
            move || {
                let n = c.fetch_add(1, SeqCst);
                async move {
                    if n == 0 {
                        Err(api_error(500))
                    } else {
                        Ok(vec![item()])
                    }
                }
            },
            shared.clone(),
            tx,
            Arc::new(emitter),
            Duration::from_secs(15),
        ));
        // Let the poller run its first (failing) tick; time is paused, so it cannot reach the next.
        while calls.load(SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        assert!(reducer.try_recv().is_err(), "no rebuild for a transient error");
        assert!(events.try_recv().is_err(), "no event for a transient error");
        assert!(shared.store().metrics.pods.contains_key("old"));
        tokio::time::advance(Duration::from_secs(15)).await;
        assert!(matches!(next(&mut reducer).await, Some(ReducerMsg::Rebuild)));
        assert!(shared.store().metrics.pods.contains_key("a"));
        task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn three_transient_failures_without_a_sample_read_as_unresponsive_until_one_arrives() {
        let shared = Shared::default();
        let (tx, mut reducer) = mpsc::channel(8);
        let (emitter, mut events) = ChannelEmitter::new();
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();
        let task = tokio::spawn(run(
            move || {
                let n = c.fetch_add(1, SeqCst);
                async move {
                    if n < 4 {
                        Err(api_error(503))
                    } else {
                        Ok(vec![item()])
                    }
                }
            },
            shared.clone(),
            tx,
            Arc::new(emitter),
            Duration::from_secs(15),
        ));
        assert!(matches!(next(&mut reducer).await, Some(ReducerMsg::Rebuild)));
        assert_eq!(calls.load(SeqCst), 3, "the third failure is the first to be reported");
        assert_eq!(
            next_event(&mut events).await,
            Some(OutEvent::MetricsUpdated(MetricsUpdate {
                state: MetricsState::Unavailable
            }))
        );
        assert!(shared.store().metrics.unresponsive);
        assert!(matches!(next(&mut reducer).await, Some(ReducerMsg::Rebuild)));
        assert_eq!(calls.load(SeqCst), 5, "the 4th failure stays quiet; polling goes on to the sample");
        assert_eq!(shared.store().metrics.state, MetricsState::Available);
        assert!(!shared.store().metrics.unresponsive);
        assert!(shared.store().metrics.sampled_at.is_some());
        task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn aborting_the_poller_drops_it_and_a_closed_reducer_stops_it() {
        // Abort (what a namespace switch does) drops the poll future, releasing what it holds.
        let token = Arc::new(());
        let held = token.clone();
        let (tx, _reducer) = mpsc::channel(8);
        let (emitter, _events) = ChannelEmitter::new();
        let task = tokio::spawn(run(
            move || {
                let _held = held.clone();
                async { Ok(vec![item()]) }
            },
            Shared::default(),
            tx,
            Arc::new(emitter),
            Duration::from_secs(15),
        ));
        tokio::task::yield_now().await;
        assert!(Arc::strong_count(&token) > 1);
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert_eq!(Arc::strong_count(&token), 1, "the aborted poller released its closure");

        // A reducer that is gone ends the loop by itself.
        let (tx, reducer) = mpsc::channel(8);
        drop(reducer);
        let (emitter, _events) = ChannelEmitter::new();
        let task = tokio::spawn(run(
            || async { Ok(vec![item()]) },
            Shared::default(),
            tx,
            Arc::new(emitter),
            Duration::from_secs(15),
        ));
        tokio::time::timeout(Duration::from_secs(60), task)
            .await
            .expect("the poller stops")
            .unwrap();
    }
}
