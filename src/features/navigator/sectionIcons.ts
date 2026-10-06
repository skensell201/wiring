import { HardDrive, KeyRound, Layers, Network, Puzzle, Server, Settings2, Ship, type LucideIcon } from "lucide-react";

/** One icon per `SECTIONS` id, plus the Custom Resources and Helm sections. */
export const SECTION_ICONS: Record<string, LucideIcon> = {
  workloads: Layers, config: Settings2, network: Network, storage: HardDrive, access: KeyRound, cluster: Server,
  custom: Puzzle, helm: Ship,
};
