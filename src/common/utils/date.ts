export const todayInTz = (tz: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
