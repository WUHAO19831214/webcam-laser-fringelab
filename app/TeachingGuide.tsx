"use client";

import { useState } from "react";
import { checkExerciseAnswer } from "@/lib/lesson";
import { SimpleCalculator } from "./SimpleCalculator";

type Exercise = { spanPx: number; spanMm: number; spacingMm: number; wavelengthNm: number } | null;

export function TeachingGuide({ ready, selecting, pointCount, intervals, exercise, revealed, dMm, distanceM, onIntervals, onSelect, onClear, onReveal }: {
  ready: boolean; selecting: boolean; pointCount: number; intervals: number; exercise: Exercise; revealed: boolean;
  dMm: number; distanceM: number;
  onIntervals: (value: number) => void; onSelect: () => void; onClear: () => void; onReveal: () => void;
}) {
  const [spacing, setSpacing] = useState("");
  const [wavelength, setWavelength] = useState("");
  const [checked, setChecked] = useState(false);
  const [hint, setHint] = useState(0);
  const feedback = (value: string, expected: number | null) => {
    const result = checkExerciseAnswer(value, expected);
    return result === "correct" ? "计算吻合（2% 范围），不代表物理测量精度。" : result === "retry" ? "再检查间隔数、毫米与米的单位换算。" : "请先选取两端亮纹，并输入正数。";
  };
  return <section className="teaching-guide" aria-label="双缝干涉教学练习">
    <div className="control-title-row lesson-heading"><h3>一起测出条纹间距</h3><div className="lesson-heading-actions"><span className="lesson-badge">引导 → 练习 → 核对</span><SimpleCalculator /></div></div>
    <p className="lesson-status">器材数据：d = {dMm} mm，L = {distanceM} m。{ready ? "当前参数与尺标已应用。" : "尚未准备好，不作为有效测量。"}</p>
    <ol className="lesson-steps">
      <li><strong>只选条纹。</strong>把分析框移到尺子上方，避开刻线和手指。多条纹平均比单个间隔更稳健。</li>
      <li><strong>读尺并标定。</strong>手动点击至少三条已知长刻线，或核对自动/OCR 候选后应用。点击刻线，不是数字中心。</li>
      <li><strong>选两端亮纹中心。</strong>点击附近自动吸附到局部亮峰中心，画面与右侧剖面同步标记 A/B；过曝平顶仅暂估中心。数出中间的间隔数 N：6 条亮纹之间是 5 个间隔。</li>
    </ol>
    <div className="button-row">
      <button type="button" className="button primary" disabled={!ready} onClick={() => { setChecked(false); onSelect(); }}>{selecting ? `请在画面点选（${pointCount}/2）` : "点选两端亮纹"}</button>
      <button type="button" className="button" onClick={() => { onClear(); setSpacing(""); setWavelength(""); setChecked(false); }}>重新练习</button>
    </div>
    {!ready ? <p className="lesson-status">先完成参数确认与尺标应用，然后开始点选。</p> : null}
    <div className="field-grid space-top-sm">
      <div className="field"><label htmlFor="lesson-n">间隔数 N（不是亮纹条数）</label><input id="lesson-n" type="number" min={1} max={30} step={1} value={intervals} onChange={(event) => { onIntervals(Number(event.currentTarget.value)); setChecked(false); }} /></div>
      <div className="lesson-observation">两端跨度 D<br /><strong>{exercise ? `${exercise.spanMm.toFixed(3)} mm` : "等待点选"}</strong><small>{exercise ? `${exercise.spanPx.toFixed(1)} 显示像素 · 依据已应用尺标` : "这是你的观测量，不是计算答案"}</small></div>
      <div className="field"><label htmlFor="lesson-spacing">你算出的 Δx / mm</label><input id="lesson-spacing" type="number" min={0} step="any" value={spacing} onChange={(event) => { setSpacing(event.currentTarget.value); setChecked(false); }} /></div>
      <div className="field"><label htmlFor="lesson-wavelength">你算出的 λ / nm</label><input id="lesson-wavelength" type="number" min={0} step="any" value={wavelength} onChange={(event) => { setWavelength(event.currentTarget.value); setChecked(false); }} /></div>
    </div>
    <div className="button-row space-top-sm">
      <button type="button" className="button" onClick={() => setHint(Math.min(3, hint + 1))}>给我提示（{hint}/3）</button>
      <button type="button" className="button" disabled={!ready || !exercise} onClick={() => setChecked(true)}>检查我的计算</button>
      <button type="button" className="button" disabled={!ready || !exercise} onClick={onReveal}>{revealed ? "重新遮蔽答案" : "揭示答案与自动结果"}</button>
    </div>
    {hint >= 1 ? <p className="lesson-status">提示 1：Δx = D / N。这里的 N 是两端亮纹之间的间隔数。</p> : null}
    {hint >= 2 ? <p className="lesson-status">提示 2：小角近似 λ = d·Δx / L；先统一为米，再乘 10⁹ 得到 nm。</p> : null}
    {hint >= 3 ? <p className="lesson-status">提示 3：如果 d 和 Δx 都用 mm、L 用 m，则 λ[nm] = 1000·d[mm]·Δx[mm] / L[m]。</p> : null}
    {checked ? <div className="notice" role="status"><p>间距：{feedback(spacing, exercise?.spacingMm ?? null)}</p><p>波长：{feedback(wavelength, exercise?.wavelengthNm ?? null)}</p></div> : null}
    {revealed && exercise ? <div className="lesson-answer"><strong>根据你选择的两端亮纹：</strong>Δx = {exercise.spanMm.toFixed(3)} / {intervals} = {exercise.spacingMm.toFixed(3)} mm；λ ≈ {exercise.wavelengthNm.toFixed(1)} nm。右侧为点击揭示时生成的自动多级回归结果，可核对计算；吸附点也使用了自动定位，因此不是独立的手动测量验证。漏数条纹、过曝和尺标误差都会影响结果。</div> : <p className="lesson-status">自动间距、波长及导出答案暂时遮蔽。遮蔽用于教学，不是安全权限控制。</p>}
  </section>;
}
