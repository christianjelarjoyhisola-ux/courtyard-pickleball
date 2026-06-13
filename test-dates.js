const now = new Date(2026, 5, 13); // June 13, 2026
const dow = now.getDay();
console.log('Today:', now.toDateString());
console.log('Day of Week:', dow); // 0=Sun, 1=Mon, ..., 5=Fri

const mondayOffset = (dow + 6) % 7;
console.log('Monday offset:', mondayOffset);

const start = new Date(now);
start.setHours(0, 0, 0, 0);
start.setDate(now.getDate() - mondayOffset - 7);
console.log('Last week start:', start.toDateString());

const end = new Date(start);
end.setDate(start.getDate() + 6);
console.log('Last week end:', end.toDateString());

const toDate = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
console.log('Last week range:', toDate(start), 'to', toDate(end));
console.log('Expected bookings in this range: 7-8 (week of 2026-06-01)');
