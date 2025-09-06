<script>
// trip.js
(() => {
  const titleEl = document.getElementById('trip-title');
  const root = document.getElementById('app');

  // Клиент Supabase: берём значения, которые ты уже вставил в trip.html
  const supabase = window.supabase.createClient(
    window.SUPABASE_URL,
    window.SUPABASE_ANON_KEY
  );

  async function main() {
    const id = new URLSearchParams(location.search).get('id');
    if (!id) {
      root.textContent = 'Не передан id поездки.';
      return;
    }

    // 1) Грузим саму поездку
    const { data: trip, error: tripErr } = await supabase
      .from('trips')
      .select('*')
      .eq('id', id)
      .single();

    if (tripErr) {
      root.innerHTML = `<div class="error">Ошибка: ${tripErr.message}</div>`;
      console.error(tripErr);
      return;
    }

    titleEl.textContent = trip.title || 'Без названия';
    root.innerHTML = `
      <div class="trip-meta">
        <p><b>Город:</b> ${trip.location || '—'}</p>
        <p><b>Даты:</b> ${fmt(trip.start_date)} — ${fmt(trip.end_date)}</p>
      </div>
      <h2>Траты</h2>
      <ul id="exp-list"></ul>
    `;

    // 2) Грузим траты по этой поездке (если есть таблица expenses)
    const { data: expenses, error: expErr } = await supabase
      .from('expenses')
      .select('*')
      .eq('trip_id', id)
      .order('date', { ascending: true });

    const list = document.getElementById('exp-list');

    if (expErr) {
      list.innerHTML = `<li class="error">Ошибка: ${expErr.message}</li>`;
      console.error(expErr);
      return;
    }

    if (!expenses || expenses.length === 0) {
      list.innerHTML = '<li>Пока нет трат.</li>';
      return;
    }

    expenses.forEach(e => {
      const li = document.createElement('li');
      li.textContent = `${fmt(e.date)} — ${e.description || 'Без описания'}: ${formatMoney(e.amount)}`;
      list.appendChild(li);
    });
  }

  function fmt(d) {
    if (!d) return '—';
    const date = new Date(d);
    if (Number.isNaN(date)) return d;
    return date.toISOString().slice(0,10);
  }

  function formatMoney(x) {
    if (x == null) return '0';
    const n = Number(x);
    return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(n);
  }

  main();
})();
</script>
