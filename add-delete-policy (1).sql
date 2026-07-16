create policy "public can delete own subscription" on push_subscriptions
  for delete
  using (true);

grant delete on push_subscriptions to anon, authenticated;
