//! Pure graph construction: Store -> Graph, Graph x Graph -> GraphDelta.

pub mod build;
pub mod diff;
pub mod model;
pub mod relations;
pub mod status;

pub use build::{build, BuildOptions};
pub use diff::diff;
pub use model::*;
