-- Espécie deixa de usar verde (cor reservada para entradas no app).
-- 1) Novos usuários: mesma função de padrões, só a cor da Espécie muda.
create or replace function privado.criar_padroes_usuario()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.categorias (usuario_id, nome, tipo, cor) values
    (new.id, 'Salário', 'receita', '#18794e'),
    (new.id, '13º / Férias', 'receita', '#2e9e6a'),
    (new.id, 'Pix recebido', 'receita', '#4caf87'),
    (new.id, 'Outras receitas', 'receita', '#7cc3a0'),
    (new.id, 'Alimentação', 'despesa', '#e8590c'),
    (new.id, 'Supermercado', 'despesa', '#f08c00'),
    (new.id, 'Transporte', 'despesa', '#1971c2'),
    (new.id, 'Moradia', 'despesa', '#5f3dc4'),
    (new.id, 'Educação', 'despesa', '#0c8599'),
    (new.id, 'Celular e internet', 'despesa', '#3b5bdb'),
    (new.id, 'Assinaturas', 'despesa', '#9c36b5'),
    (new.id, 'Lazer', 'despesa', '#d6336c'),
    (new.id, 'Saúde', 'despesa', '#c92a2a'),
    (new.id, 'Compras', 'despesa', '#e67700'),
    (new.id, 'Família', 'despesa', '#a61e4d'),
    (new.id, 'Outras despesas', 'despesa', '#6d7b8f');
  insert into public.contas (usuario_id, nome, tipo, cor) values
    (new.id, 'Nubank', 'corrente', '#8a05be'),
    (new.id, 'Itaú', 'corrente', '#ec7000'),
    (new.id, 'Banpará', 'corrente', '#0b5394'),
    (new.id, 'Espécie', 'carteira', '#8c7a5b');
  return new;
end; $$;
revoke all on function privado.criar_padroes_usuario() from public, anon, authenticated;

-- 2) Contas existentes: só troca se ainda estiver com o verde padrão (preserva cor escolhida pelo usuário).
update public.contas
   set cor = '#8c7a5b'
 where nome = 'Espécie' and tipo = 'carteira' and lower(cor) = '#2f9e44';
