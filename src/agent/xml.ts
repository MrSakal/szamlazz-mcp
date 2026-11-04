/**
 * A small XML writer for Agent API requests: elements are plain objects, empty values are
 * dropped, text is escaped. Element names are Számlázz.hu's (they come from its XSDs).
 */

export type Scalar = string | number | boolean;

export interface XmlElement {
  name: string;
  value?: Scalar;
  children?: XmlElement[];
}

type Maybe = XmlElement | null | undefined | false;

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

// Characters XML 1.0 does not allow at all: most C0 controls, U+FFFE and U+FFFF.
// eslint-disable-next-line no-control-regex
const NOT_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

export function escapeText(text: string): string {
  return text.replace(NOT_XML, "").replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

/** A leaf element, or nothing when the value is missing or an empty string. */
export function leaf(name: string, value: Scalar | null | undefined): XmlElement | null {
  if (value === undefined || value === null || value === "") return null;
  return { name, value };
}

/** An element with child elements; missing children are skipped. */
export function branch(name: string, children: Maybe[]): XmlElement {
  return { name, children: children.filter((c): c is XmlElement => Boolean(c)) };
}

function serialize(element: XmlElement, indent: string, lines: string[]): void {
  if (element.children) {
    lines.push(`${indent}<${element.name}>`);
    for (const child of element.children) serialize(child, indent + "  ", lines);
    lines.push(`${indent}</${element.name}>`);
  } else {
    lines.push(`${indent}<${element.name}>${escapeText(String(element.value ?? ""))}</${element.name}>`);
  }
}

/** The full request document: XML declaration, then the root element in the given namespace. */
export function xmlDocument(root: XmlElement, namespace: string): string {
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', `<${root.name} xmlns="${namespace}">`];
  for (const child of root.children ?? []) serialize(child, "  ", lines);
  lines.push(`</${root.name}>`);
  return lines.join("\n");
}
