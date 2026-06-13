const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://ruoyywzehhgkkxswicoa.supabase.co';
const SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ1b3l5d3plaGhna2t4c3dpY29hIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTE5NTA2MywiZXhwIjoyMDk2NzcxMDYzfQ.1rMr2rCTq5Hsr7FzJjN2wH0jcHZC0C2O_qpERkQmQe0';

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const fs = require('fs');
const migration = fs.readFileSync('./supabase/migrations/20260613_weekly_billing.sql', 'utf8');

(async () => {
  try {
    console.log('Executing migration...');
    
    // Supabase doesn't have a direct raw SQL endpoint, so we'll execute using psql via command line
    // But first, let's try via REST with individual statements
    
    // Split by ; and execute statements
    const statements = migration
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));
    
    console.log(`Found ${statements.length} SQL statements`);
    
    // Try using the sql.new endpoint which accepts arbitrary SQL
    const res = await fetch(`${SUPABASE_URL}/rest/v1/`, {
      method: 'OPTIONS',
      headers: {
        'Content-Type': 'application/json',
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
      }
    });
    
    console.log('Testing API connectivity...', res.status);
    
    // Verify if weekly_fees table exists
    try {
      const { data, error } = await sb.from('weekly_fees').select('*', { count: 'exact', head: true });
      if (!error) {
        console.log('✓ weekly_fees table already exists');
        process.exit(0);
      }
    } catch (err) {
      console.log('Table does not exist yet, attempting creation...');
    }
    
    // Since we can't execute raw SQL via REST API, we need to inform the user
    console.error('⚠ Supabase REST API does not support arbitrary SQL execution.');
    console.error('You must manually run the migration in the Supabase SQL Editor:');
    console.error('1. Go to Supabase Dashboard → SQL Editor');
    console.error('2. Create a new query and paste the contents of supabase/migrations/20260613_weekly_billing.sql');
    console.error('3. Click "Run"');
    
  } catch (err) {
    console.error('Error:', err.message);
  }

  process.exit(1);
})();
