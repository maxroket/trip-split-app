// trip_split_app/public/app.js
(() => {
  const root = document.getElementById('app');

  // Клиент Supabase: берём значения из index.html
  const supabase = window.supabase.createClient(
    window.SUPABASE_URL,
    window.SUPABASE_ANON_KEY
  );

  async function main() {
    // Читаем все поездки из таблицы 'trips'
    const { data: trips, error } = await supabase
      .from('trips')
      .select('*')
      .order('id', { ascending: true });

    if (error) {
      root.innerHTML = `<div class="error">Ошибка: ${error.message}</div>`;
      console.error(error);
      return;
    }

    if (!trips || trips.length === 0) {
      root.innerHTML = '<p>Пока нет поездок. Добавим позже.</p>';
      return;
    }

    const list = document.createElement('ul');
    trips.forEach(t => {
      const li = document.createElement('li');
      li.textContent = `${t.title || 'Без названия'} — ${t.location || ''}`;
      list.appendChild(li);
    });

    root.innerHTML = '';
    root.appendChild(list);
  }

  main();
})();
