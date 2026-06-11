// Creates admin accounts directly via Supabase Auth Admin API (no email confirmation needed)
// Run: node create-accounts.js

const SUPABASE_URL = 'https://ruoyywzehhgkkxswicoa.supabase.co';
const SERVICE_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ1b3l5d3plaGhna2t4c3dpY29hIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTE5NTA2MywiZXhwIjoyMDk2NzcxMDYzfQ.1rMr2rCTq5Hsr7FzJjN2wH0jcHZC0C2O_qpERkQmQe0';

const { createClient } = require('@supabase/supabase-js');
const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const ACCOUNTS = [
  { email: 'owner@smashgrove.demo', password: 'SmashDemo2026!', username: 'courtowner', full_name: 'Court Owner', role: 'developer' },
  { email: 'manager@smashgrove.demo', password: 'SmashDemo2026!', username: 'courtmanager', full_name: 'Court Manager', role: 'manager' },
];

async function run() {
  console.log('Creating admin accounts in Supabase project:', SUPABASE_URL, '\n');

  for (const acc of ACCOUNTS) {
    // 1. Create auth user (auto-confirmed via admin API)
    const { data: authData, error: authErr } = await sb.auth.admin.createUser({
      email: acc.email,
      password: acc.password,
      email_confirm: true,   // bypass email confirmation
      user_metadata: { full_name: acc.full_name, role: acc.role }
    });

    if (authErr) {
      console.log(`  ✗ Auth create [${acc.email}]: ${authErr.message}`);
      
      // If user already exists, try to find them
      if (authErr.message.includes('already') || authErr.status === 422) {
        const { data: users } = await sb.auth.admin.listUsers();
        const existing = users?.users?.find(u => u.email === acc.email);
        if (existing) {
          console.log(`    → Found existing user: ${existing.id}`);
          await upsertAccountRow(existing.id, acc);
        }
      }
      continue;
    }

    const uid = authData.user.id;
    console.log(`  ✓ Auth user created: ${acc.email} (id: ${uid})`);

    // 2. Insert row in public.accounts
    await upsertAccountRow(uid, acc);
  }

  console.log('\nDone! Login credentials:');
  console.log('  URL:      https://smash-grove-bambulo-dun.vercel.app/login.html');
  for (const acc of ACCOUNTS) {
    console.log(`  ${acc.role === 'developer' ? 'Owner  ' : 'Manager'}: ${acc.email} / ${acc.password}`);
  }
}

async function upsertAccountRow(uid, acc) {
  const { error } = await sb.from('accounts').upsert({
    id: uid,
    username: acc.username,
    full_name: acc.full_name,
    email: acc.email,
    role: acc.role,
  }, { onConflict: 'id' });

  if (error) console.log(`  ✗ accounts table insert [${acc.email}]: ${error.message}`);
  else console.log(`  ✓ accounts row inserted: ${acc.username} (${acc.role})`);
}

run().catch(e => console.error('Fatal:', e.message));
