import mark from "../../assets/mark.svg";

/** The brand in the title bar: the mark and the wordmark. Expanded it shows both; collapsed it
 *  shows the mark alone, so the bar keeps the app's identity in a column that is only as wide
 *  as the collapsed panel. */
export function Brand({ collapsed = false }: { collapsed?: boolean }) {
  if (collapsed) {
    return <img src={mark} alt="" data-testid="brand-mark" width={20} height={20} className="select-none" draggable={false} />;
  }
  return (
    <span className="flex min-w-0 items-center gap-2.5 text-[15px] font-semibold tracking-[-0.2px] text-text-hi">
      <img src={mark} alt="" data-testid="brand-mark" width={24} height={24} className="select-none" draggable={false} />
      <span className="truncate">Wiring</span>
    </span>
  );
}
