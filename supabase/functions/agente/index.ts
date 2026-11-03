// Função "agente": análise do mês e chat sobre as finanças do usuário logado.
// A lógica fica em agente.js (testada em tests/agente.mjs); aqui só ligamos ao ambiente do Supabase.
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { tratar } from './agente.js';

Deno.serve((req: Request) => tratar(req, { env: Deno.env.toObject(), criarCliente: createClient }));
