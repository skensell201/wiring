import { HardDrive, KeyRound, Layers, Network, Settings2, type LucideIcon } from "lucide-react";

/** One icon per `SECTIONS` id. */
export const SECTION_ICONS: Record<string, LucideIcon> = {
  workloads: Layers, config: Settings2, network: Network, storage: HardDrive, access: KeyRound,
};
