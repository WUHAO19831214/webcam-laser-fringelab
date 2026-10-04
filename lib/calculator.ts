/** Small arithmetic parser. No eval, scripts, variables or access to experiment answers. */
export function calculateExpression(expression: string): number {
  const source = expression.replaceAll("×", "*").replaceAll("÷", "/").replaceAll("−", "-");
  let cursor = 0;
  const skip = () => { while (/\s/.test(source[cursor] ?? "") && cursor < source.length) cursor++; };
  const take = (token: string) => { skip(); if (source[cursor] === token) { cursor++; return true; } return false; };
  const primary = (): number => {
    if (take("(")) { const value = sum(); if (!take(")")) throw new Error("括号未配对"); return value; }
    skip();
    const match = source.slice(cursor).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
    if (!match) throw new Error("请输入数字和运算符");
    cursor += match[0].length;
    return Number(match[0]);
  };
  const power = (): number => { const value = primary(); return take("^") ? value ** unary() : value; };
  const unary = (): number => take("+") ? unary() : take("-") ? -unary() : power();
  const product = (): number => {
    let value = unary();
    while (true) {
      if (take("*")) value *= unary();
      else if (take("/")) { const divisor = unary(); if (divisor === 0) throw new Error("不能除以零"); value /= divisor; }
      else return value;
    }
  };
  const sum = (): number => { let value = product(); while (true) { if (take("+")) value += product(); else if (take("-")) value -= product(); else return value; } };
  if (!source.trim() || source.length > 300) throw new Error("请输入不超过 300 字符的算式");
  const result = sum(); skip();
  if (cursor !== source.length || !Number.isFinite(result)) throw new Error("算式无效或结果超出范围");
  return result;
}
