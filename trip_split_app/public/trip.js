(async () => {
  const root = document.getElementById('app');
  const titleEl = document.getElementById('trip-title');

  // Берём id из адресной строки: /trip.html?id=...
  const tripId = new URLSearchParams(location.search).get('id');
  if (!tripId) {
    root.innerHTML = '<p class="error">Не передан id поездки.</p>';
    return;
  }

  // Клиент Supabase
  const supabase = window.supabase.createClient(
    window.SUPABASE_URL,
    window.SUPABASE_ANON_KEY
  );

  // Загружаем саму поездку
  const { data: trip, error: tripErr } = await supabase
    .from('trips')
    .select('*')
    .eq('id', tripId)
    .single();

  if (tripErr) {
    root.innerHTML = `<p class="error">Ошибка: ${tripErr.message}</p>`;
    return;
  }

  titleEl.textContent = `${trip.title || 'Без названия'} — ${trip.location || ''}`.trim();

  // Загружаем расходы по этой поездке
  const { data: expenses, error: expErr } = await supabase
    .from('expenses')
    .select('*')
    .eq('trip_id', tripId)
    .order('date', { ascending: false });

  if (expErr) {
    root.innerHTML = `<p class="error">Ошибка: ${expErr.message}</p>`;
    return;
  }

  if (!expenses || expenses.length === 0) {
    root.innerHTML = '<p>Пока расходов нет.</p>';
    return;
  }

  // Рендерим список расходов (минимально)
  const ul = document.createElement('ul');
  expenses.forEach(e => {
    const li = document.createElement('li');
    const amount = (e.amount != null) ? e.amount : '';
    const when = e.date ? new Date(e.date).toLocaleDateString() : '';
    li.textContent = `${when} — ${e.description || 'Без описания'} — ${amount}`;
    ul.appendChild(li);
  });

  root.innerHTML = '';
  root.appendChild(ul);
})();
