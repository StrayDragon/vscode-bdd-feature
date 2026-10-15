/** Minimal glob → RegExp (only `**` and `*` segment wildcards). */
export function globToRegExp(pattern: string): RegExp {
  const parts = pattern.split('/');
  let re = '^';
  for (const part of parts) {
    if (part === '**') {
      re += '(?:.*/)?';
    } else {
      re += part.replace(/\./g, '\\.').replace(/\*/g, '[^/]*') + '/';
    }
  }
  re = re.replace(/\/$/, '') + '$';
  return new RegExp(re);
}

export function matchesAnyGlob(relPath: string, globs: readonly string[]): boolean {
  for (const g of globs) {
    if (globToRegExp(g).test(relPath)) {
      return true;
    }
  }
  return false;
}
