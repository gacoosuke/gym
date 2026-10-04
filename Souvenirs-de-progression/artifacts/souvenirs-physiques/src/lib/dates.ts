function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function localDateTimeFromDate(date: Date): string {
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  ].join('T');
}

export function localDateTimeToIso(value: string): string {
  const localDate = new Date(value);
  if (!Number.isFinite(localDate.getTime())) {
    throw new Error('La date de prise de vue est invalide.');
  }

  const offsetMinutes = -localDate.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffset = Math.abs(offsetMinutes);
  return `${value.slice(0, 16)}${sign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`;
}