import mark from "../../assets/mark.svg";

/** The brand, at the top of the navigator's column. Expanded it shows the mark and the wordmark;
 *  collapsed the column is only as wide as the rail, so it shows the mark alone. */
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
