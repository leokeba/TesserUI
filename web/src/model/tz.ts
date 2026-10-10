// IANA time zone → POSIX TZ string (what newlib's tzset() reads on the
// device), from the offsets the browser's Intl reports over the current year.

// Minutes east of UTC in `zone` at `t` (ms).
function offsetFn(zone: string): (t: number) => number {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  });
  return (t) => {
    const p: Record<string, number> = {};
    for (const x of f.formatToParts(t)) p[x.type] = Number(x.value);
    return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(t / 60000) * 60000) / 60000);
  };
}

const pad = (n: number) => String(n).padStart(2, '0');
// "+0530"-style name and POSIX offset (west positive: UTC+1 is "-1").
const name = (m: number) => `<${m < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(m) / 60))}${Math.abs(m) % 60 ? pad(Math.abs(m) % 60) : ''}>`;
const hm = (m: number) => `${Math.floor(m / 60)}${m % 60 ? ':' + pad(m % 60) : ''}`;
const posixOffset = (m: number) => (m > 0 ? '-' : '') + hm(Math.abs(m));

// "Mm.w.d/time" for an instant, in the local time of the offset in force
// before it.
function rule(t: number, before: number): string {
  const d = new Date(t + before * 60000);
  const day = d.getUTCDate();
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  const week = day + 7 > last ? 5 : Math.ceil(day / 7);
  const time = d.getUTCHours() * 60 + d.getUTCMinutes();
  return `M${d.getUTCMonth() + 1}.${week}.${d.getUTCDay()}${time === 120 ? '' : '/' + hm(time)}`;
}

export function posixTz(zone: string, year = new Date().getUTCFullYear()): string {
  const off = offsetFn(zone);
  const start = Date.UTC(year, 0, 1);
  const day = 86400000;
  const changes: [number, number, number][] = []; // instant, offset before, after
  let prev = off(start);
  for (let t = start + day; t < start + 366 * day; t += day) {
    const cur = off(t);
    if (cur === prev) continue;
    // To the minute.
    let lo = t - day;
    let hi = t;
    while (hi - lo > 60000) {
      const mid = lo + Math.floor((hi - lo) / 120000) * 60000;
      if (off(mid) === prev) lo = mid;
      else hi = mid;
    }
    changes.push([hi, prev, cur]);
    prev = cur;
  }
  if (changes.length !== 2) return `${name(prev)}${posixOffset(prev)}`;
  const std = Math.min(changes[0][1], changes[0][2]);
  const dst = Math.max(changes[0][1], changes[0][2]);
  const on = changes.find((c) => c[2] === dst)!;
  const offc = changes.find((c) => c[2] === std)!;
  const dstPart = dst - std === 60 ? '' : posixOffset(dst);
  return `${name(std)}${posixOffset(std)}${name(dst)}${dstPart},${rule(on[0], std)},${rule(offc[0], dst)}`;
}
