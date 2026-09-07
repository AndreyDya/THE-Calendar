// This client uses the SECRET key, not the publishable one — it has full
// database access and must never be imported into any file that runs in
// the browser. It's only safe here because Next.js API routes run
// exclusively on the server.
import { createClient } from '@supabase/supabase-js';

export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!
);
