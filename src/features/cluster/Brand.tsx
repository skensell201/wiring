import mark from "../../assets/mark.svg";

/** The brand in the title bar: the mark and the wordmark. It never changes with the navigator:
 *  a logo that swaps itself for a letter while the sidebar collapses makes the title bar jump. */
export function Brand() {
  return (
    <span className="flex shrink-0 items-center gap-2 text-base font-semibold tracking-[-0.1px] text-text-hi">
      <img src={mark} alt="" width={22} height={22} className="select-none" draggable={false} />
      Wiring
    </span>
  );
}
