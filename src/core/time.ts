/**
 * Преобразование локального времени аккаунта в UTC с явной обработкой
 * переходов на летнее время. Время в БД хранится в UTC.
 */
export type LocalResolution =
  | { kind: "ok"; utc: Date }
  | { kind: "gap"; suggestedUtc: Date; message: string }
  | { kind: "ambiguous"; earlierUtc: Date; laterUtc: Date; message: string };

function offsetMinutes(utcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - utcMs) / 60000);
}

/** local: "YYYY-MM-DDTHH:mm" в часовом поясе timeZone. */
export function resolveLocal(local: string, timeZone: string): LocalResolution {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) throw new Error("Ожидается формат YYYY-MM-DDTHH:mm");
  const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  // Кандидаты: все смещения, встречающиеся в окрестности ±36 часов.
  const offsets = new Set<number>();
  for (let h = -36; h <= 36; h += 3) offsets.add(offsetMinutes(naive + h * 3600_000, timeZone));
  const matches = [...offsets]
    .map((off) => naive - off * 60000)
    .filter((utc) => offsetMinutes(utc, timeZone) * 60000 === naive - utc)
    .sort((a, b) => a - b);
  const uniq = [...new Set(matches)];
  if (uniq.length === 1) return { kind: "ok", utc: new Date(uniq[0]) };
  if (uniq.length > 1) {
    return {
      kind: "ambiguous", earlierUtc: new Date(uniq[0]), laterUtc: new Date(uniq[uniq.length - 1]),
      message: `Время ${local} в ${timeZone} встречается дважды (переход с летнего времени). Выберите вариант явно.`,
    };
  }
  const before = offsetMinutes(naive - 12 * 3600_000, timeZone);
  return {
    kind: "gap", suggestedUtc: new Date(naive - before * 60000),
    message: `Времени ${local} в ${timeZone} не существует (переход на летнее время). Выберите другое время.`,
  };
}

export function formatInZone(d: Date, timeZone: string, locale = "ru-RU"): string {
  return new Intl.DateTimeFormat(locale, { timeZone, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }).format(d);
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
