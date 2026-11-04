import { Node, type JsxAttribute, type JsxSpreadAttribute, type Project, type Type } from 'ts-morph';
import { findJsxAt, type JsxOpening } from './index';

/** What the property panel needs to know about one element's styling in the source. */
export interface StyleSource {
  /** The source tag the panel's operations target. */
  target: string;
  /**
   * `static`: the classes are one plain string, or there is no className yet, so a control can change them.
   * `locked`: they are built in code, and `reason` says how, in plain words. Controls are disabled, never guessed.
   */
  className: { kind: 'static'; classes: string[] } | { kind: 'locked'; reason: string };
  /** Props written as plain strings, such as intent="quiet". A prop set by code is null. */
  props: Record<string, string | null>;
}

const ASK = 'Ask for the change instead.';

/** Whether a component takes a className where it is used, from its props type. Unknown types count as yes. */
function acceptsClassName(opening: JsxOpening): boolean {
  const type = opening.getTagNameNode().getType();
  const signature = type.getCallSignatures()[0] ?? type.getConstructSignatures()[0];
  if (!signature) return true;
  const props = signature.getParameters()[0];
  if (!props) return false;
  const propsType = props.getTypeAtLocation(opening.getTagNameNode());
  return propsType.isAny() || propsType.isUnknown() || propsType.getProperty('className') !== undefined;
}

/** Whether a value of this type could hold a className. Only a type that plainly has none counts as no. */
function canHoldClassName(type: Type): boolean {
  if (type.isAny() || type.isUnknown() || type.isTypeParameter()) return true;
  if (type.isUnion()) return type.getUnionTypes().some(canHoldClassName);
  if (type.isNull() || type.isUndefined()) return false;
  return type.getProperty('className') !== undefined || type.getStringIndexType() !== undefined;
}

/**
 * The spread on an element that decides its className at run time, if there is one. Later attributes win in JSX, so
 * a spread after a written className overrides it, and with no className written any spread can supply one. A spread
 * before a written className loses to it, and a spread whose type has no className never matters.
 */
export function classNameSpread(opening: JsxOpening): JsxSpreadAttribute | undefined {
  const attributes = opening.getAttributes();
  const written = attributes.findIndex((a) => Node.isJsxAttribute(a) && a.getNameNode().getText() === 'className');
  return attributes.slice(written + 1).find((a): a is JsxSpreadAttribute => Node.isJsxSpreadAttribute(a) && canHoldClassName(a.getExpression().getType()));
}

function lockedReason(expression: Node | undefined): string {
  if (!expression) return `The styles on this element are set in code. ${ASK}`;
  if (Node.isCallExpression(expression)) return `The styles on this element are built by ${expression.getExpression().getText()}(...) in the code, so these controls can't change them safely. ${ASK}`;
  if (Node.isConditionalExpression(expression)) return `The styles on this element depend on a condition in the code, so these controls can't change them safely. ${ASK}`;
  if (Node.isIdentifier(expression) || Node.isPropertyAccessExpression(expression) || Node.isElementAccessExpression(expression)) {
    return `The styles on this element come from ${expression.getText()} in the code, so these controls can't change them safely. ${ASK}`;
  }
  return `The styles on this element are put together from several pieces in the code, so these controls can't change them safely. ${ASK}`;
}

/** Read an element's className and literal props. Null when no element starts at the tag. */
export function styleSource(project: Project, root: string, tag: string): StyleSource | null {
  const found = findJsxAt(project, root, tag);
  if (!found) return null;
  const { opening } = found;
  const name = opening.getTagNameNode().getText();
  const attributes = opening.getAttributes().filter((a): a is JsxAttribute => Node.isJsxAttribute(a));

  const props: StyleSource['props'] = {};
  for (const attribute of attributes) {
    const init = attribute.getInitializer();
    const value = init && Node.isJsxExpression(init) ? init.getExpression() : init;
    props[attribute.getNameNode().getText()] = value && (Node.isStringLiteral(value) || Node.isNoSubstitutionTemplateLiteral(value)) ? value.getLiteralText() : null;
  }

  // Checked first: with a spread in charge, neither a missing className nor a written one says what the element gets.
  const spread = classNameSpread(opening);
  if (spread) {
    return { target: tag, props, className: { kind: 'locked', reason: `The styles on this element can come from {...${spread.getExpression().getText()}} in the code, so these controls can't change them safely. ${ASK}` } };
  }
  const classAttribute = attributes.find((a) => a.getNameNode().getText() === 'className');
  if (!classAttribute) {
    if (/^[A-Z]/.test(name) && !acceptsClassName(opening)) {
      return { target: tag, props, className: { kind: 'locked', reason: `${name} doesn't take styles where it is used. Its look is set inside the component. Change its options, or ask for the change.` } };
    }
    return { target: tag, props, className: { kind: 'static', classes: [] } };
  }
  const literal = props.className;
  if (typeof literal === 'string') return { target: tag, props, className: { kind: 'static', classes: literal.split(/\s+/).filter(Boolean) } };
  const init = classAttribute.getInitializer();
  return { target: tag, props, className: { kind: 'locked', reason: lockedReason(init && Node.isJsxExpression(init) ? init.getExpression() : init) } };
}
