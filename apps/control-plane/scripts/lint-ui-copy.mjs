import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const roots = ["app", "components"];
const failures = [];

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.isFile() && path.endsWith(".tsx") ? [path] : [];
  });
}

function checkText(file, source, node, text, kind) {
  const normalized = text.replace(/&[a-z]+;/gi, "").replace(/\s+/g, " ").trim();
  if (!normalized) return;
  const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  if (normalized.includes("—")) {
    failures.push(`${file}:${line} ${kind} contains an em dash`);
  }
  if (normalized.includes(";")) {
    failures.push(`${file}:${line} ${kind} contains a semicolon`);
  }
}

for (const root of roots) {
  for (const file of filesUnder(join(process.cwd(), root))) {
    const sourceText = readFileSync(file, "utf8");
    const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node) {
      if (ts.isJsxText(node)) checkText(file, source, node, node.text, "JSX copy");
      if (
        ts.isJsxAttribute(node) &&
        node.initializer &&
        ts.isStringLiteral(node.initializer)
      ) {
        checkText(file, source, node, node.initializer.text, `attribute ${node.name.getText(source)}`);
        const parentTag =
          ts.isJsxOpeningElement(node.parent) || ts.isJsxSelfClosingElement(node.parent)
            ? node.parent.tagName.getText(source)
            : "";
        if (
          parentTag === "PageFrame" &&
          node.name.getText(source) === "description" &&
          node.initializer.text.trim().endsWith(".")
        ) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          failures.push(`${file}:${line} ${node.name.getText(source)} has a trailing period`);
        }
      }
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(source) === "toast" &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        checkText(file, source, node.arguments[0], node.arguments[0].text, "toast copy");
        if (node.arguments[0].text.trim().endsWith(".")) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          failures.push(`${file}:${line} toast has a trailing period`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("UI copy lint passed");
}
