// Safe arithmetic expression evaluator — replaces Function constructor
// with a recursive descent parser that only allows known variables,
// basic arithmetic, and whitelisted Math.* members.

const MATH_FUNCS: Record<string, (...args: number[]) => number> = {
  "Math.sqrt": Math.sqrt,
  "Math.pow": Math.pow,
  "Math.abs": Math.abs,
  "Math.log": Math.log,
  "Math.exp": Math.exp,
  "Math.sin": Math.sin,
  "Math.cos": Math.cos,
  "Math.tan": Math.tan,
  "Math.ceil": Math.ceil,
  "Math.floor": Math.floor,
  "Math.round": Math.round,
  "Math.min": Math.min,
  "Math.max": Math.max,
};

const MATH_CONSTS: Record<string, number> = {
  "Math.PI": Math.PI,
  "Math.E": Math.E,
  "Math.LN2": Math.LN2,
  "Math.LN10": Math.LN10,
  "Math.LOG2E": Math.LOG2E,
  "Math.LOG10E": Math.LOG10E,
  "Math.SQRT2": Math.SQRT2,
  "Math.SQRT1_2": Math.SQRT1_2,
};

type Token =
  | { type: "number"; value: number }
  | { type: "ident"; value: string }
  | { type: "op"; value: string }
  | { type: "paren"; value: "(" | ")" }
  | { type: "comma"; value: "," };

function tokenize(expr: string, allowedVars: Set<string>): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    if (/\s/.test(expr[i])) { i++; continue; }

    // Numbers (including decimals and scientific notation)
    if (/[\d.]/.test(expr[i])) {
      let num = "";
      while (i < expr.length && /[\d.]/.test(expr[i])) num += expr[i++];
      if (i < expr.length && /[eE]/.test(expr[i])) {
        num += expr[i++];
        if (i < expr.length && /[+-]/.test(expr[i])) num += expr[i++];
        while (i < expr.length && /\d/.test(expr[i])) num += expr[i++];
      }
      tokens.push({ type: "number", value: parseFloat(num) });
      continue;
    }

    // Math.* functions and constants
    if (expr.startsWith("Math.", i)) {
      let end = i + 5;
      while (end < expr.length && /\w/.test(expr[end])) end++;
      const name = expr.slice(i, end);
      if (name in MATH_CONSTS) {
        tokens.push({ type: "number", value: MATH_CONSTS[name] });
        i = end;
        continue;
      }
      if (name in MATH_FUNCS) {
        tokens.push({ type: "ident", value: name });
        i = end;
        continue;
      }
      throw new Error(`Unknown Math member: ${name}`);
    }

    // Variable identifiers (longest match among allowed vars, then single-char fallback)
    if (/[a-zA-Z_]/.test(expr[i])) {
      let ident = "";
      const start = i;
      while (i < expr.length && /[\w]/.test(expr[i])) ident += expr[i++];
      if (!allowedVars.has(ident)) {
        // Try longest-prefix match for multi-char symbols
        let found = false;
        for (const v of allowedVars) {
          if (expr.startsWith(v, start)) {
            tokens.push({ type: "ident", value: v });
            i = start + v.length;
            found = true;
            break;
          }
        }
        if (!found) throw new Error(`Unknown variable: ${ident}`);
        continue;
      }
      tokens.push({ type: "ident", value: ident });
      continue;
    }

    // ** operator (must check before single *)
    if (expr[i] === "*" && i + 1 < expr.length && expr[i + 1] === "*") {
      tokens.push({ type: "op", value: "**" });
      i += 2;
      continue;
    }

    if ("+-*/%".includes(expr[i])) {
      tokens.push({ type: "op", value: expr[i] });
      i++;
      continue;
    }

    if (expr[i] === "(" || expr[i] === ")") {
      tokens.push({ type: "paren", value: expr[i] as "(" | ")" });
      i++;
      continue;
    }

    if (expr[i] === ",") {
      tokens.push({ type: "comma", value: "," });
      i++;
      continue;
    }

    throw new Error(`Unexpected character: ${expr[i]}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private tokens: Token[], private vars: Record<string, number>) {}

  parse(): number {
    const result = this.addSub();
    if (this.pos < this.tokens.length) {
      throw new Error("Unexpected token after expression");
    }
    return result;
  }

  private peek(): Token | undefined { return this.tokens[this.pos]; }
  private advance(): Token { return this.tokens[this.pos++]; }

  private addSub(): number {
    let left = this.mulDiv();
    while (this.peek()?.type === "op" && (this.peek()!.value === "+" || this.peek()!.value === "-")) {
      const op = this.advance().value;
      const right = this.mulDiv();
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }

  private mulDiv(): number {
    let left = this.power();
    while (this.peek()?.type === "op" && "*/%".includes(this.peek()!.value as string) && this.peek()!.value !== "**") {
      const op = this.advance().value;
      const right = this.power();
      if (op === "*") left *= right;
      else if (op === "/") left /= right;
      else left %= right;
    }
    return left;
  }

  private power(): number {
    const base = this.unary();
    if (this.peek()?.type === "op" && this.peek()!.value === "**") {
      this.advance();
      return Math.pow(base, this.power()); // right-associative
    }
    return base;
  }

  private unary(): number {
    if (this.peek()?.type === "op" && (this.peek()!.value === "+" || this.peek()!.value === "-")) {
      const op = this.advance().value;
      return op === "-" ? -this.unary() : this.unary();
    }
    return this.primary();
  }

  private primary(): number {
    const tok = this.peek();
    if (!tok) throw new Error("Unexpected end of expression");

    if (tok.type === "number") {
      this.advance();
      return tok.value;
    }

    if (tok.type === "ident") {
      this.advance();
      // Math function call
      if (tok.value in MATH_FUNCS) {
        if (this.peek()?.type !== "paren" || this.peek()!.value !== "(") {
          throw new Error(`Expected ( after ${tok.value}`);
        }
        this.advance();
        const args: number[] = [this.addSub()];
        while (this.peek()?.type === "comma") {
          this.advance();
          args.push(this.addSub());
        }
        if (this.peek()?.type !== "paren" || this.peek()!.value !== ")") {
          throw new Error(`Expected ) after ${tok.value} arguments`);
        }
        this.advance();
        return MATH_FUNCS[tok.value](...args);
      }
      // Variable
      if (tok.value in this.vars) return this.vars[tok.value];
      throw new Error(`Unknown identifier: ${tok.value}`);
    }

    if (tok.type === "paren" && tok.value === "(") {
      this.advance();
      const val = this.addSub();
      if (this.peek()?.type !== "paren" || this.peek()!.value !== ")") {
        throw new Error("Expected )");
      }
      this.advance();
      return val;
    }

    throw new Error(`Unexpected token: ${JSON.stringify(tok)}`);
  }
}

export function evaluateFormula(formula: string, values: Record<string, number>): number {
  if (!formula || !formula.trim()) throw new Error("Empty formula");
  const allowedVars = new Set(Object.keys(values));
  const tokens = tokenize(formula, allowedVars);
  return new Parser(tokens, values).parse();
}
