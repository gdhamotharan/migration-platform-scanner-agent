import { XMLParser, XMLValidator } from 'fast-xml-parser';

const XML_PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: false,
  parseTagValue: false,
  trimValues: true
});

export function parseSafeXml(content) {
  if (typeof content !== 'string' || /<!DOCTYPE|<!ENTITY/i.test(content)) {
    throw new Error('XML declarations are not supported.');
  }
  if (XMLValidator.validate(content) !== true) throw new Error('Malformed XML manifest.');
  return XML_PARSER.parse(content);
}

export function xmlText(node, key) {
  const value = node?.[key];
  if (Array.isArray(value)) return xmlText(value[0], '#text');
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (value && typeof value === 'object' && typeof value['#text'] === 'string') return value['#text'].trim();
  return undefined;
}

export function xmlNodes(value, targetKey, output = []) {
  if (!value || typeof value !== 'object') return output;
  if (Array.isArray(value)) {
    for (const item of value) xmlNodes(item, targetKey, output);
    return output;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === targetKey) output.push(...(Array.isArray(child) ? child : [child]));
    else xmlNodes(child, targetKey, output);
  }
  return output;
}

export function xmlItemsWithConditions(value, targetKey, conditions = [], output = []) {
  if (!value || typeof value !== 'object') return output;
  if (Array.isArray(value)) {
    for (const item of value) xmlItemsWithConditions(item, targetKey, conditions, output);
    return output;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith('@_')) continue;
    const nodes = Array.isArray(child) ? child : [child];
    for (const node of nodes) {
      const condition = node && typeof node === 'object' ? node['@_Condition'] : undefined;
      const nextConditions = condition ? [...conditions, condition] : conditions;
      if (key === targetKey) output.push({ node, conditions });
      else xmlItemsWithConditions(node, targetKey, nextConditions, output);
    }
  }
  return output;
}
