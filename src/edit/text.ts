import { Node, type Identifier, type JsxChild, type Project } from 'ts-morph';
import { projectPath } from '../extract/project';
import type { SourceRef } from '../extract/types';
import { componentAt, findJsxAt, type RepoIndex } from './index';

/** Where an element's text is written, and whether editing it on the page can become a `set-text` operation. */
export type TextSource =
  | { editable: true; target: string; file: string; line: number; text: string }
  | {
    editable: false;
    /** `prop`: passed in by whoever renders the component. `data`: a variable, an import, or a computed value. */
    reason: 'prop' | 'data' | 'mixed' | 'empty' | 'missing';
    /** Plain words for the person, saying where the text lives. */
    message: string;
    file?: string;
    line?: number;
    prop?: string;
  };

/** A JSX child that is text written in place: plain text, or a string in braces such as {"a < b"}. */
export function isLiteralTextChild(child: JsxChild): boolean {
  if (Node.isJsxText(child)) return true;
  if (!Node.isJsxExpression(child)) return false;
  const expression = child.getExpression();
  return expression !== undefined && (Node.isStringLiteral(expression) || Node.isNoSubstitutionTemplateLiteral(expression));
}

function literalText(child: JsxChild): string {
  if (Node.isJsxText(child)) return child.getText();
  const expression = Node.isJsxExpression(child) ? child.getExpression() : undefined;
  return expression && (Node.isStringLiteral(expression) || Node.isNoSubstitutionTemplateLiteral(expression)) ? expression.getLiteralText() : '';
}

/** Whitespace as the page shows it: runs collapse to one space and the ends are trimmed. */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

type Origin = { kind: 'prop'; prop?: string } | { kind: 'data'; at?: SourceRef };

const isFunction = (node: Node | undefined) => node !== undefined && (Node.isFunctionDeclaration(node) || Node.isFunctionExpression(node) || Node.isArrowFunction(node));

/** The first identifier in an expression, which is the root of a chain such as project.tags.map(...). */
function rootIdentifier(node: Node): Identifier | undefined {
  if (Node.isIdentifier(node)) return node;
  return node.getDescendants().find((d): d is Identifier => Node.isIdentifier(d));
}

/**
 * Follow a value back to where it is declared. A callback parameter such as `project` in `projects.map((project) =>`
 * leads to the list; a local such as `const project = projects.find(...)` leads to what it was computed from. A
 * parameter of the component itself is a prop.
 */
function originOf(root: string, id: Identifier, depth = 0): Origin {
  const symbol = id.getSymbol();
  const target = symbol?.isAlias() ? symbol.getAliasedSymbol() : symbol;
  const decl = target?.getDeclarations()[0];
  if (!decl) return { kind: 'data' };

  let binding: Node = decl;
  let name: string | undefined;
  while (Node.isBindingElement(binding)) {
    name ??= (binding.getPropertyNameNode() ?? binding.getNameNode()).getText();
    binding = binding.getParentOrThrow().getParentOrThrow();
  }

  if (Node.isParameterDeclaration(binding)) {
    const fn = binding.getParent();
    const call = fn?.getParent();
    // A function passed to a method, such as items.map(fn), gets its values from the object the method is called on.
    const callee = call && Node.isCallExpression(call) ? call.getExpression() : undefined;
    // React.forwardRef(fn) and React.memo(fn) wrap a component; they aren't loops.
    if (isFunction(fn) && callee && Node.isPropertyAccessExpression(callee) && !/^(forwardRef|memo)$/.test(callee.getName())) {
      const list = rootIdentifier(callee);
      return list && depth < 6 ? originOf(root, list, depth + 1) : { kind: 'data' };
    }
    if (!name) {
      // props.title: the name is the property read off the parameter.
      const access = id.getParent();
      if (access && Node.isPropertyAccessExpression(access) && access.getExpression() === id) name = access.getName();
    }
    return { kind: 'prop', prop: name };
  }

  const file = projectPath(root, decl.getSourceFile().getFilePath());
  if (!file) return { kind: 'data' };
  const at = { file, line: decl.getStartLineNumber() };
  if (Node.isVariableDeclaration(binding)) {
    const init = binding.getInitializer();
    // Keep going only through values computed from something else, not through the data itself.
    const computed = init && (Node.isCallExpression(init) || Node.isPropertyAccessExpression(init) || Node.isElementAccessExpression(init) || Node.isAwaitExpression(init) || Node.isIdentifier(init));
    const from = computed ? rootIdentifier(init) : undefined;
    if (from && depth < 6) {
      const origin = originOf(root, from, depth + 1);
      if (origin.kind === 'prop' || origin.at) return origin;
    }
  }
  return { kind: 'data', at };
}

/**
 * Decide whether the text of the element at `tag` can be edited in place. It can when every child is text written
 * right there in the JSX. Text from a prop, a variable, or data can't, and the answer says where it lives instead.
 * `usedAt` is the place on the page that renders the component, when the caller knows it.
 */
export function textSource(project: Project, root: string, index: RepoIndex, tag: string, usedAt?: SourceRef): TextSource {
  const found = findJsxAt(project, root, tag);
  if (!found) return { editable: false, reason: 'missing', message: 'That element is no longer in the code. Click it again.' };
  const { sf, file, line, opening } = found;
  const element = Node.isJsxOpeningElement(opening) ? opening.getParentOrThrow() : opening;
  const children = Node.isJsxElement(element) ? element.getJsxChildren().filter((c) => !(Node.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces())) : [];
  if (!children.length) return { editable: false, reason: 'empty', message: 'There is no text in this element to edit.', file, line };
  if (children.every(isLiteralTextChild)) {
    return { editable: true, target: tag, file, line, text: normalizeText(children.map(literalText).join('')) };
  }
  if (children.some((c) => Node.isJsxElement(c) || Node.isJsxSelfClosingElement(c) || Node.isJsxFragment(c))) {
    return { editable: false, reason: 'mixed', message: 'This element holds other elements, not only text. Double-click the text itself, or ask for the change.', file, line };
  }

  const dynamic = children.find((c) => !isLiteralTextChild(c))!;
  const id = rootIdentifier(dynamic);
  const origin: Origin = id ? originOf(root, id) : { kind: 'data' };
  if (origin.kind === 'prop') {
    const component = componentAt(index, sf, file, opening.getStart())?.name ?? 'this component';
    const where = usedAt ? `, in ${usedAt.file} line ${usedAt.line}` : '';
    const what = origin.prop ? `the ${origin.prop} prop of ${component}` : `a prop of ${component}`;
    return { editable: false, reason: 'prop', prop: origin.prop, message: `This text is ${what}. It is set where ${component} is used${where}.`, file: usedAt?.file ?? file, line: usedAt?.line ?? line };
  }
  if (origin.at) {
    return { editable: false, reason: 'data', message: `This text comes from data in ${origin.at.file}, line ${origin.at.line}. It can't be edited on the page.`, ...origin.at };
  }
  return { editable: false, reason: 'data', message: "This text comes from data, so it can't be edited on the page." };
}
