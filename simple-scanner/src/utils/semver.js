const IDENTIFIER = '(?:0|[1-9]\\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)';
export const SEMVER_PATTERN = new RegExp(
  `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(?:${IDENTIFIER})(?:\\.(?:${IDENTIFIER}))*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`
);

export function isSemver(value) {
  return typeof value === 'string' && SEMVER_PATTERN.test(value);
}
