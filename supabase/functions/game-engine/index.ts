// @ts-nocheck
// =============================================================================
// Kafkasino :: Supabase Edge Function — game-engine
// =============================================================================
// Optional Edge Function wrapper around the authoritative database RPCs.
// Can be invoked either by clients (`supabase.functions.invoke('game-engine', ...)`)
// or by a scheduled cron to sweep any expired `turn_deadline` across all open rooms.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const authHeader = req.headers.get('Authorization');

    const body = (await req.json().catch(() => ({}))) as {
      op?: 'sweep_timeouts' | 'claim_timeout';
      room_id?: string;
    };

    // Service client for sweeping expired deadlines across all active rooms.
    if (body.op === 'sweep_timeouts') {
      const admin = createClient(supabaseUrl, serviceRoleKey);
      const { data: expiredRooms, error } = await admin
        .from('game_states')
        .select('room_id')
        .not('turn_user_id', 'is', null)
        .lte('turn_deadline', new Date().toISOString())
        .limit(50);

      if (error) throw error;

      const results = [];
      for (const row of expiredRooms ?? []) {
        const { data } = await admin.rpc('claim_turn_timeout', { p_room_id: row.room_id });
        results.push(data);
      }

      return new Response(JSON.stringify({ ok: true, swept: results.length, results }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Authenticated player invocation for a specific room.
    if (!authHeader || !body.room_id) {
      return new Response(JSON.stringify({ ok: false, error: 'missing_parameters' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const client = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data, error } = await client.rpc('claim_turn_timeout', { p_room_id: body.room_id });
    if (error) throw error;

    return new Response(JSON.stringify({ ok: true, data }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'internal_error';
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

