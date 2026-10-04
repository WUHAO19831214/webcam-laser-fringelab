"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { calculateExpression } from "@/lib/calculator";

export function SimpleCalculator() {
  const [open, setOpen] = useState(false);
  const [expression, setExpression] = useState("");
  const [result, setResult] = useState("");
  const [position, setPosition] = useState({ left: 16, top: 90 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogId = useId();
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = triggerRef.current?.closest(".teaching-guide")?.getBoundingClientRect();
      const panel = panelRef.current?.getBoundingClientRect();
      if (!anchor || !panel) return;
      setPosition({ left: Math.max(16, Math.min(anchor.right + 16, window.innerWidth - panel.width - 16)), top: Math.max(80, Math.min(anchor.top, window.innerHeight - panel.height - 16)) });
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); triggerRef.current?.focus(); } };
    place(); inputRef.current?.focus({ preventScroll: true });
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, { passive: true });
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place); window.removeEventListener("keydown", escape); };
  }, [open]);
  const calculate = () => {
    try { setResult(`= ${Number(calculateExpression(expression).toPrecision(12))}`); }
    catch (error) { setResult(error instanceof Error ? error.message : "请检查算式"); }
  };
  return <>
    <button ref={triggerRef} type="button" className="button calculator-trigger" aria-expanded={open} aria-controls={dialogId} aria-haspopup="dialog" onClick={() => setOpen(!open)}>{open ? "收起计算器" : "打开计算器"}</button>
    {open ? createPortal(<section ref={panelRef} id={dialogId} className="calculator-panel calculator-floating" role="dialog" aria-label="辅助计算器" style={{ left: position.left, top: position.top }}>
      <div className="control-title-row"><h3>辅助计算器</h3><button type="button" className="button" onClick={() => { setOpen(false); triggerRef.current?.focus(); }}>关闭计算器</button></div>
      <p className="ruler-footnote">自行输入算式，不读取实验答案、不代填练习。支持括号、^ 乘方和 e 科学计数。</p>
      <label className="field" htmlFor="calculator-expression"><span>计算表达式</span><input ref={inputRef} id="calculator-expression" inputMode="text" maxLength={300} placeholder="例如：(12 + 8) / 5" value={expression} onChange={(event) => { setExpression(event.currentTarget.value); setResult(""); }} onKeyDown={(event) => { if (event.key === "Enter") calculate(); }} /></label>
      <output className="calculator-output" aria-live="polite">{result || "等待计算"}</output>
      <div className="calculator-keys">{["7", "8", "9", "÷", "4", "5", "6", "×", "1", "2", "3", "−", "0", ".", "^", "+", "(", ")", "e", "⌫"].map((key) => <button type="button" className="button" key={key} onClick={() => { setExpression(key === "⌫" ? expression.slice(0, -1) : expression + key); setResult(""); }}>{key}</button>)}</div>
      <div className="button-row space-top-sm"><button type="button" className="button primary" onClick={calculate}>计算</button><button type="button" className="button" onClick={() => { setExpression(""); setResult(""); }}>清空</button></div>
    </section>, document.body) : null}
  </>;
}
