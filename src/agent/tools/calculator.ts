import { z } from "zod";
import { FunctionTool, ToolError } from "./base.js";

const CalculatorArgsSchema = z.object({
    expression: z.string().min(1),
});

export type CalculatorArgs = z.infer<typeof CalculatorArgsSchema>;

/**
 * Evaluate a safe arithmetic expression.
 *
 * Only numeric literals, parentheses, and the operators
 * `+ - * / % ** //` are permitted. Names, calls, attribute access,
 * subscripts, and comprehensions are rejected at the tokenizer level —
 * there is no path from a token to a host-language construct.
 *
 * Semantics match Python's `ast`-based evaluation:
 *   - `**` is right-associative and binds tighter than unary `+`/`-`
 *   - `//` is floor division (works for negatives)
 *   - `%` is Python-style floor modulo (e.g. `-7 % 2 === 1`)
 *   - exponents with `|exp| > 100` are rejected
 *   - numeric literals may use `_` digit separators (e.g. `1_000`)
 */
export function evaluateExpression(expression: string): number {
    const tokens = tokenize(expression);
    if (tokens.length === 0) throw new ToolError("empty expression");
    const parser = new Parser(tokens);
    const result = parser.parseExpr();
    parser.expectEnd();
    return result;
}

type Token =
    | { kind: "num"; value: number }
    | { kind: "op"; value: string }
    | { kind: "lparen" }
    | { kind: "rparen" };

const OPERATOR_CHARS: ReadonlySet<string> = new Set(["+", "-", "*", "/", "%"]);
const WHITESPACE: ReadonlySet<string> = new Set([" ", "\t", "\n", "\r"]);

function tokenize(input: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    while (i < input.length) {
        const ch = input[i]!;
        if (WHITESPACE.has(ch)) {
            i += 1;
            continue;
        }
        if (ch >= "0" && ch <= "9") {
            const start = i;
            while (i < input.length && isDigitOrUnderscore(input[i]!)) i += 1;
            if (i < input.length && input[i] === ".") {
                i += 1;
                while (i < input.length && isDigitOrUnderscore(input[i]!)) i += 1;
            }
            if (i < input.length && (input[i] === "e" || input[i] === "E")) {
                i += 1;
                if (i < input.length && (input[i] === "+" || input[i] === "-")) i += 1;
                while (i < input.length && isDigitOrUnderscore(input[i]!)) i += 1;
            }
            const raw = input.slice(start, i);
            validateNumberLiteral(raw);
            const value = Number(raw.replace(/_/g, ""));
            if (!Number.isFinite(value)) {
                throw new ToolError(`invalid number literal: ${raw}`);
            }
            tokens.push({ kind: "num", value });
            continue;
        }
        if (ch === "*" && input[i + 1] === "*") {
            tokens.push({ kind: "op", value: "**" });
            i += 2;
            continue;
        }
        if (ch === "/" && input[i + 1] === "/") {
            tokens.push({ kind: "op", value: "//" });
            i += 2;
            continue;
        }
        if (OPERATOR_CHARS.has(ch)) {
            tokens.push({ kind: "op", value: ch });
            i += 1;
            continue;
        }
        if (ch === "(") {
            tokens.push({ kind: "lparen" });
            i += 1;
            continue;
        }
        if (ch === ")") {
            tokens.push({ kind: "rparen" });
            i += 1;
            continue;
        }
        throw new ToolError(`unsupported character: ${JSON.stringify(ch)}`);
    }
    return tokens;
}

function isDigitOrUnderscore(ch: string): boolean {
    return (ch >= "0" && ch <= "9") || ch === "_";
}

function validateNumberLiteral(raw: string): void {
    if (raw.startsWith("_") || raw.endsWith("_") || raw.includes("__")) {
        throw new ToolError(`invalid number literal: ${raw}`);
    }
    if (raw.includes("._") || raw.includes("_.")) {
        throw new ToolError(`invalid number literal: ${raw}`);
    }
    if (
        raw.includes("e_") ||
        raw.includes("E_") ||
        raw.includes("_e") ||
        raw.includes("_E")
    ) {
        throw new ToolError(`invalid number literal: ${raw}`);
    }
}

class Parser {
    private pos = 0;

    constructor(private readonly tokens: Token[]) { }

    parseExpr(): number {
        let left = this.parseTerm();
        while (true) {
            const tok = this.peek();
            if (tok?.kind === "op" && (tok.value === "+" || tok.value === "-")) {
                this.pos += 1;
                const right = this.parseTerm();
                left = tok.value === "+" ? left + right : left - right;
                continue;
            }
            return left;
        }
    }

    parseTerm(): number {
        let left = this.parseFactor();
        while (true) {
            const tok = this.peek();
            if (
                tok?.kind === "op" &&
                (tok.value === "*" ||
                    tok.value === "/" ||
                    tok.value === "%" ||
                    tok.value === "//")
            ) {
                this.pos += 1;
                const right = this.parseFactor();
                if (tok.value === "*") {
                    left = left * right;
                } else if (tok.value === "/") {
                    if (right === 0) throw new ToolError("division by zero");
                    left = left / right;
                } else if (tok.value === "//") {
                    if (right === 0) throw new ToolError("division by zero");
                    left = Math.floor(left / right);
                } else {
                    // Python-style floor modulo.
                    if (right === 0) throw new ToolError("modulo by zero");
                    left = ((left % right) + right) % right;
                }
                continue;
            }
            return left;
        }
    }

    parseFactor(): number {
        const tok = this.peek();
        if (tok?.kind === "op" && (tok.value === "+" || tok.value === "-")) {
            this.pos += 1;
            const inner = this.parseFactor();
            return tok.value === "-" ? -inner : inner;
        }
        return this.parsePower();
    }

    parsePower(): number {
        const base = this.parseAtom();
        const tok = this.peek();
        if (tok?.kind === "op" && tok.value === "**") {
            this.pos += 1;
            const exponent = this.parseFactor();
            if (Math.abs(exponent) > 100) {
                throw new ToolError("exponent too large");
            }
            return base ** exponent;
        }
        return base;
    }

    parseAtom(): number {
        const tok = this.tokens[this.pos];
        if (tok === undefined) throw new ToolError("unexpected end of expression");
        if (tok.kind === "num") {
            this.pos += 1;
            return tok.value;
        }
        if (tok.kind === "lparen") {
            this.pos += 1;
            const inner = this.parseExpr();
            const close = this.tokens[this.pos];
            if (close?.kind !== "rparen") throw new ToolError("expected ')'");
            this.pos += 1;
            return inner;
        }
        throw new ToolError("unexpected token");
    }

    expectEnd(): void {
        if (this.pos < this.tokens.length) {
            throw new ToolError("unexpected trailing token");
        }
    }

    private peek(): Token | undefined {
        return this.tokens[this.pos];
    }
}

export const calculatorTool = new FunctionTool({
    name: "calculator",
    description:
        "Evaluate a safe arithmetic expression using only numbers, parentheses, " +
        "and the operators +, -, *, /, %, **, //.",
    argsSchema: CalculatorArgsSchema,
    fn: ({ expression }) => evaluateExpression(expression),
});