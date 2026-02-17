/**
 * シンプルなglobマッチング実装
 * 外部依存を避けるための最小実装
 */

/**
 * globパターンを正規表現に変換
 */
function globToRegex(pattern: string): RegExp {
  let regex = '';
  let i = 0;

  while (i < pattern.length) {
    const c = pattern[i];

    switch (c) {
      case '*':
        if (pattern[i + 1] === '*') {
          // ** は任意のディレクトリを含むパス
          if (pattern[i + 2] === '/') {
            regex += '(?:[^/]+/)*';
            i += 3;
          } else {
            regex += '.*';
            i += 2;
          }
        } else {
          // * は単一ディレクトリ内の任意の文字列
          regex += '[^/]*';
          i++;
        }
        break;

      case '?':
        regex += '[^/]';
        i++;
        break;

      case '.':
      case '+':
      case '^':
      case '$':
      case '(':
      case ')':
      case '{':
      case '}':
      case '|':
      case '\\':
        regex += '\\' + c;
        i++;
        break;

      case '[':
        // 文字クラス
        let j = i + 1;
        while (j < pattern.length && pattern[j] !== ']') {
          j++;
        }
        if (j < pattern.length) {
          regex += pattern.slice(i, j + 1);
          i = j + 1;
        } else {
          regex += '\\[';
          i++;
        }
        break;

      default:
        regex += c;
        i++;
    }
  }

  return new RegExp('^' + regex + '$');
}

/**
 * パスがglobパターンにマッチするかチェック
 */
export function minimatch(filepath: string, pattern: string): boolean {
  // パスを正規化（バックスラッシュをスラッシュに）
  const normalizedPath = filepath.replace(/\\/g, '/');
  const normalizedPattern = pattern.replace(/\\/g, '/');

  try {
    const regex = globToRegex(normalizedPattern);
    return regex.test(normalizedPath);
  } catch {
    return false;
  }
}
