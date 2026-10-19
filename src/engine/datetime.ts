// {{ time=FORMAT }} support: .NET/JungleDocs-style date formatting. Copied verbatim from the legacy engine.

// Weekday/month names for {{ time=FORMAT }} (session 9), spelled the standard way (Jan, not this
// file's own old irregular 'june'/'july'/'sept' abbreviations -- see formatDateTime's comment for
// why standard spelling was chosen deliberately over reusing this file's pre-existing convention).
export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tues', 'Wed', 'Thurs', 'Fri', 'Sat'];

export const WEEKDAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const MONTH_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

export const MONTH_FULL = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

// Format one run of the SAME format-letter (e.g. "MMMM", "hh") against a Date, following the
// JungleDocs / .NET custom date-format token table -- see formatDateTime's comment for the full
// list. Returns the run itself, unchanged, for any letter not in that table (defensive; every
// caller only ever invokes this on a run whose first letter was already checked to be recognized).
export function formatDateToken(date: Date, run: string): string {
  const letter = run[0];
  const len = run.length;
  const pad = (n: number, width: number): string => String(Math.abs(n)).padStart(width, '0');
  switch (letter) {
    case 'd':
      if (len >= 4) return WEEKDAY_FULL[date.getDay()];
      if (len === 3) return WEEKDAY_SHORT[date.getDay()];
      if (len === 2) return pad(date.getDate(), 2);
      return String(date.getDate());
    case 'M':
      if (len >= 4) return MONTH_FULL[date.getMonth()];
      if (len === 3) return MONTH_SHORT[date.getMonth()];
      if (len === 2) return pad(date.getMonth() + 1, 2);
      return String(date.getMonth() + 1);
    case 'y': {
      const fullYear = date.getFullYear();
      if (len >= 3) return String(fullYear);
      const twoDigit = ((fullYear % 100) + 100) % 100;
      return len === 2 ? pad(twoDigit, 2) : String(twoDigit);
    }
    case 'h': {
      const hour24 = date.getHours();
      const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
      return len >= 2 ? pad(hour12, 2) : String(hour12);
    }
    case 'H':
      return len >= 2 ? pad(date.getHours(), 2) : String(date.getHours());
    case 'm':
      return len >= 2 ? pad(date.getMinutes(), 2) : String(date.getMinutes());
    case 's':
      return len >= 2 ? pad(date.getSeconds(), 2) : String(date.getSeconds());
    case 't': {
      const isPM = date.getHours() >= 12;
      return len >= 2 ? (isPM ? 'PM' : 'AM') : isPM ? 'P' : 'A';
    }
    case 'f':
    case 'F': {
      // Real precision stops at milliseconds (3 digits); padded with zeros out to `len` (max 7,
      // matching the table's f..fffffff range). 'F' additionally drops trailing zero digits.
      const msDigits = (pad(date.getMilliseconds(), 3) + '0000').slice(0, len);
      return letter === 'F' ? msDigits.replace(/0+$/, '') : msDigits;
    }
    case 'K':
    case 'z': {
      // JS reports getTimezoneOffset() as minutes BEHIND UTC (positive west of UTC) -- inverted
      // from the conventional +HH:mm offset notation, so the sign is flipped here.
      const offsetMinutes = -date.getTimezoneOffset();
      const sign = offsetMinutes < 0 ? '-' : '+';
      const absMinutes = Math.abs(offsetMinutes);
      const offsetHours = Math.floor(absMinutes / 60);
      const remainderMinutes = absMinutes % 60;
      if (letter === 'K' || len >= 3) {
        return `${sign}${pad(offsetHours, 2)}:${pad(remainderMinutes, 2)}`;
      }
      return len === 2 ? `${sign}${pad(offsetHours, 2)}` : `${sign}${offsetHours}`;
    }
    default:
      return run;
  }
}

// {{ time=FORMAT }} (session 9): format the current render's captured date/time using JungleDocs-
// style custom date-format patterns (https://help-jungledocs.enovapoint.com/article/714-date-
// formatting-formulas -- itself the .NET custom date/time format string grammar). Recognized
// letters, each read as a RUN of repeated occurrences (so "MM" and "MMMM" are different tokens,
// not "M" twice):
//   d/dd            day of month, no/with leading zero          M/MM      month, no/with leading zero
//   ddd/dddd        weekday name, abbreviated/full                MMM/MMMM  month name, abbreviated/full
//   h/hh            12-hour hour, no/with leading zero            H/HH      24-hour hour, no/with leading zero
//   m/mm            minutes, no/with leading zero                 s/ss      seconds, no/with leading zero
//   t/tt            AM/PM, abbreviated (A/P) / full (AM/PM)        y/yy/yyy(y) year: unpadded 2-digit /
//                                                                             padded 2-digit / full 4-digit
//   f..fffffff      fractional seconds, zero-padded (real precision stops at milliseconds)
//   F..FFFFFFF      same, with trailing zero digits dropped
//   K, z/zz/zzz     time zone offset (K and zzz are always +HH:mm; z/zz are +H / +HH)
// Any other character (including `:` and `/`) passes through literally. Wrap literal text that
// would otherwise be misread as a token in single or double quotes: 'at' or "at".
// Example: {{ time=dddd, MMMM d, yyyy }}  ->  Tuesday, March 3, 2026
export function formatDateTime(date: Date, format: string): string {
  const isTokenLetter = (ch: string): boolean => 'dMyHhmstKzfF'.includes(ch);
  let result = '';
  let i = 0;
  while (i < format.length) {
    const ch = format[i];
    if (ch === "'" || ch === '"') {
      const closeIndex = format.indexOf(ch, i + 1);
      if (closeIndex === -1) {
        result += format.slice(i + 1);
        i = format.length;
      } else {
        result += format.slice(i + 1, closeIndex);
        i = closeIndex + 1;
      }
      continue;
    }
    if (isTokenLetter(ch)) {
      let run = ch;
      let j = i + 1;
      while (format[j] === ch) {
        run += ch;
        j += 1;
      }
      result += formatDateToken(date, run);
      i = j;
      continue;
    }
    result += ch;
    i += 1;
  }
  return result;
}
