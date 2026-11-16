import mark from "../../assets/mark.svg";
import w from "../../assets/w.svg";
import { useAppStore } from "../../app/store";

/** The brand in the title bar: the mark and the wordmark, or just the letter when the navigator
 *  is collapsed and the rail is too narrow for the mark. */
export function Brand() {
  const collapsed = useAppStore((s) => s.sidebarCollapsed);
  if (collapsed) {
    return (
      <span className="flex shrink-0 items-center">
        <img src={w} alt="Wiring" width={20} height={20} className="select-none" draggable={false} />
      </span>
    );
  }
  return (
    <span className="flex shrink-0 items-center gap-2 text-base font-semibold tracking-[-0.1px] text-text-hi">
      <img src={mark} alt="" width={22} height={22} className="select-none" draggable={false} />
      Wiring
    </span>
  );
}
