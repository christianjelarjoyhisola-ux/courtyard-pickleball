const { createClient } = require('@supabase/supabase-js');

const sb = createClient('https://ruoyywzehhgkkxswicoa.supabase.co', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ1b3l5d3plaGhna2t4c3dpY29hIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTE5NTA2MywiZXhwIjoyMDk2NzcxMDYzfQ.1rMr2rCTq5Hsr7FzJjN2wH0jcHZC0C2O_qpERkQmQe0', {
  auth: { autoRefreshToken: false, persistSession: false }
});

(async () => {
  try {
    console.log('=== Accounts ===');
    const { data: accounts } = await sb.from('accounts').select('*');
    if (accounts) {
      console.table(accounts.map(a => ({ id: a.id, name: a.full_name, email: a.email, role: a.role })));
    }
    
    console.log('\n=== Settings (billing-related) ===');
    const { data: settings } = await sb.from('settings').select('key, value');
    if (settings) {
      settings.filter(s => s.key.includes('fee') || s.key.includes('billing') || s.key.includes('maintenance')).forEach(s => {
        console.log(`${s.key} = ${s.value}`);
      });
    }
    
    console.log('\n=== Bookings by status ===');
    const { data: bookings } = await sb.from('bookings').select('status');
    if (bookings) {
      const counts = {};
      bookings.forEach(b => { counts[b.status] = (counts[b.status] || 0) + 1; });
      console.table(counts);
    }
    
  } catch (err) {
    console.error('Error:', err.message);
  }
  process.exit(0);
})();
