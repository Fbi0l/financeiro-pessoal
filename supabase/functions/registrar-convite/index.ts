// Função "registrar-convite": o convidado cria a própria conta pelo link (sem login prévio).
// A lógica fica em cadastro.js (testada em tests/registrar-convite.mjs).
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { tratarCadastro } from './cadastro.js';

Deno.serve((req: Request) => tratarCadastro(req, { env: Deno.env.toObject(), criarCliente: createClient }));
