// Основной файл клиентской логики.  Здесь реализованы функции загрузки
// списка поездок, отображения конкретной поездки, добавления участников,
// расходов и переводов, а также построения графического представления
// балансов и матрицы задолженностей.

(function() {
  const state = {
    trips: [],
    currentTrip: null,
    lastExpenseDate: null,
  };

  const appEl = document.getElementById('app');

  /**
   * Утилита для отправки запросов на сервер.  Автоматически
   * сериализует тело и добавляет заголовок Content‑Type: application/json.
   */
  async function apiRequest(method, url, body) {
    const opts = {
      method,
      headers: {
        'Content-Type': 'application/json'
      },
    };
    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    if (!res.ok) {
      const errorBody = await res.json().catch(() => ({}));
      throw new Error(errorBody.error || res.statusText);
    }
    return res.json();
  }

  /**
   * Инициализация приложения.  В зависимости от текущего пути
   * загружает список поездок или конкретную поездку.
   */
  function init() {
    window.addEventListener('popstate', () => {
      loadPage();
    });
    loadPage();
  }

  /**
   * Загружает страницу в зависимости от URL.  Если путь выглядит как
   * /trip/<id>, загружает конкретную поездку.  Иначе показывает список
   * поездок.
   */
  function loadPage() {
    const parts = window.location.pathname.split('/').filter(Boolean);
    if (parts[0] === 'trip' && parts[1]) {
      loadTrip(parts[1]);
    } else {
      loadTrips();
    }
  }

  /**
   * Навигация по сайту без перезагрузки страницы.  Меняет адрес в
   * истории и загружает соответствующий контент.
   */
  function navigateTo(path) {
    history.pushState({}, '', path);
    loadPage();
  }

  /**
   * Загрузка списка поездок с сервера и отображение их в виде карточек.
   */
  async function loadTrips() {
    try {
      const data = await apiRequest('GET', '/api/trips');
      state.trips = data.trips;
      renderTripList();
    } catch (err) {
      renderError(err.message);
    }
  }

  /**
   * Отрисовка списка поездок.  Создаёт формы для добавления новой
   * поездки и карточки с информацией о существующих поездках.
   */
  function renderTripList() {
    const container = document.createElement('div');
    container.className = 'trip-list';
    // Заголовок и форма создания
    const createCard = document.createElement('div');
    createCard.className = 'card';
    createCard.innerHTML = `
      <h2>Создать поездку</h2>
      <form id="create-trip-form">
        <label>Название поездки
          <input type="text" name="name" required placeholder="Например, Вьетнам 2025">
        </label>
        <label>Локация
          <input type="text" name="location" placeholder="Страна или город">
        </label>
        <button type="submit" class="btn">Создать</button>
      </form>
    `;
    container.appendChild(createCard);
    // Список существующих поездок
    if (state.trips.length > 0) {
      state.trips.forEach(trip => {
        const card = document.createElement('div');
        card.className = 'card';
        const start = trip.start_date ? formatDate(trip.start_date) : '—';
        const end = trip.end_date ? formatDate(trip.end_date) : '—';
        card.innerHTML = `
          <h2>${escapeHtml(trip.name)}</h2>
          <p><strong>Локация:</strong> ${trip.location ? escapeHtml(trip.location) : '—'}</p>
          <p><strong>Даты:</strong> ${start} – ${end}</p>
          <button class="btn" data-trip-id="${trip.id}">Открыть</button>
        `;
        container.appendChild(card);
      });
    } else {
      const emptyCard = document.createElement('div');
      emptyCard.className = 'card';
      emptyCard.innerHTML = '<p>Пока поездок нет. Создайте первую поездку, чтобы начать!</p>';
      container.appendChild(emptyCard);
    }
    appEl.innerHTML = '';
    appEl.appendChild(container);
    // Обработчик создания поездки
    const form = document.getElementById('create-trip-form');
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      const formData = new FormData(form);
      const name = formData.get('name').trim();
      const location = formData.get('location').trim();
      try {
        const result = await apiRequest('POST', '/api/trips', {
          name,
          location: location || ''
        });
        // После создания сразу переходим к поездке
        navigateTo(`/trip/${result.id}`);
      } catch (err) {
        alert('Ошибка при создании поездки: ' + err.message);
      }
    });
    // Обработчик открытия поездки
    const buttons = container.querySelectorAll('button[data-trip-id]');
    buttons.forEach(btn => {
      btn.addEventListener('click', () => {
        const tripId = btn.getAttribute('data-trip-id');
        navigateTo(`/trip/${tripId}`);
      });
    });
  }

  /**
   * Загрузка информации о конкретной поездке с сервера.  После
   * загрузки сохраняет в состоянии и вызывает рендер.
   */
  async function loadTrip(tripId) {
    try {
      const trip = await apiRequest('GET', `/api/trips/${tripId}`);
      state.currentTrip = trip;
      // Определяем последнюю дату расхода для автоподстановки
      let lastDate = null;
      if (trip.expenses && trip.expenses.length > 0) {
        const sorted = trip.expenses
          .filter(e => e.date)
          .sort((a, b) => (a.date < b.date ? 1 : -1));
        if (sorted.length) lastDate = sorted[0].date;
      }
      if (!lastDate && trip.transfers && trip.transfers.length > 0) {
        const sortedTr = trip.transfers
          .filter(t => t.date)
          .sort((a, b) => (a.date < b.date ? 1 : -1));
        if (sortedTr.length) lastDate = sortedTr[0].date;
      }
      // default to today if nothing
      state.lastExpenseDate = lastDate || new Date().toISOString().substr(0, 10);
      renderTrip();
    } catch (err) {
      renderError(err.message);
    }
  }

  /**
   * Отрисовка страницы конкретной поездки.  Создаёт секции: информация
   * о поездке, участники, балансы и диаграмма, расходы, переводы и
   * матрица задолженностей.
   */
  function renderTrip() {
    const trip = state.currentTrip;
    if (!trip) return;
    const container = document.createElement('div');
    container.className = 'trip-detail';
    // Кнопка назад
    const backBtn = document.createElement('button');
    backBtn.className = 'btn btn-secondary';
    backBtn.textContent = '← Назад к списку';
    backBtn.addEventListener('click', () => navigateTo('/'));
    container.appendChild(backBtn);
    // Информация о поездке
    const infoCard = document.createElement('div');
    infoCard.className = 'card';
    infoCard.innerHTML = `
      <h2>${escapeHtml(trip.name)}</h2>
      <p><strong>Локация:</strong> ${trip.location ? escapeHtml(trip.location) : '—'}</p>
      <p><strong>Даты:</strong> ${trip.start_date ? formatDate(trip.start_date) : '—'} – ${trip.end_date ? formatDate(trip.end_date) : '—'}</p>
    `;
    container.appendChild(infoCard);
    // Секция участников
    const participantsCard = document.createElement('div');
    participantsCard.className = 'card';
    const participantsHtml = trip.participants
      .map(p => `<li>${escapeHtml(p.name)}</li>`)
      .join('');
    participantsCard.innerHTML = `
      <h2>Участники</h2>
      <ul>${participantsHtml || '<li>Пока участников нет.</li>'}</ul>
      <form id="add-participant-form">
        <label>Имя
          <input type="text" name="name" required placeholder="Имя участника">
        </label>
        <button type="submit" class="btn">Добавить</button>
      </form>
    `;
    container.appendChild(participantsCard);
    // Балансы и диаграмма
    const balancesCard = document.createElement('div');
    balancesCard.className = 'card';
    balancesCard.innerHTML = `<h2>Баланс участников</h2>`;
    // Список балансов
    const balancesDiv = document.createElement('div');
    balancesDiv.className = 'balances';
    const net = trip.net_balances || {};
    const maxAbs = Math.max(...Object.values(net).map(v => Math.abs(v)), 0.01);
    Object.entries(net).forEach(([pid, value]) => {
      const participant = trip.participants.find(p => p.id === pid);
      const div = document.createElement('div');
      div.className = 'balance-item ';
      if (value > 0.01) {
        div.classList.add('balance-positive');
      } else if (value < -0.01) {
        div.classList.add('balance-negative');
      } else {
        div.classList.add('balance-zero');
      }
      const formatted = formatCurrency(value);
      div.textContent = `${participant ? participant.name : pid}: ${formatted}`;
      balancesDiv.appendChild(div);
    });
    balancesCard.appendChild(balancesDiv);
    // Диаграмма
    const chartDiv = document.createElement('div');
    chartDiv.className = 'bar-chart';
    Object.entries(net).forEach(([pid, value]) => {
      const participant = trip.participants.find(p => p.id === pid);
      const barContainer = document.createElement('div');
      barContainer.className = 'bar';
      const label = document.createElement('span');
      label.textContent = participant ? participant.name : pid;
      barContainer.appendChild(label);
      const barInner = document.createElement('div');
      barInner.className = 'bar-inner';
      const height = Math.abs(value) / maxAbs * 100;
      barInner.style.height = `${height}%`;
      if (value > 0.01) {
        barInner.style.backgroundColor = 'var(--color-success)';
      } else if (value < -0.01) {
        barInner.style.backgroundColor = 'var(--color-danger)';
      } else {
        barInner.style.backgroundColor = 'var(--color-secondary)';
      }
      barContainer.appendChild(barInner);
      chartDiv.appendChild(barContainer);
    });
    balancesCard.appendChild(chartDiv);
    container.appendChild(balancesCard);
    // Последние 5 расходов
    const expensesCard = document.createElement('div');
    expensesCard.className = 'card';
    expensesCard.innerHTML = `<h2>Последние расходы</h2>`;
    const expenses = (trip.expenses || []).slice().sort((a,b) => (a.date > b.date ? -1 : 1));
    const lastFive = expenses.slice(0, 5);
    if (lastFive.length > 0) {
      const table = document.createElement('table');
      table.innerHTML = `
        <thead>
          <tr>
            <th>Дата</th>
            <th>Плательщик</th>
            <th>Описание</th>
            <th>Сумма</th>
          </tr>
        </thead>
        <tbody>
          ${lastFive.map(exp => {
            const payer = trip.participants.find(p => p.id === exp.payer_id);
            return `<tr>
              <td>${exp.date ? formatDate(exp.date) : '—'}</td>
              <td>${payer ? escapeHtml(payer.name) : exp.payer_id}</td>
              <td>${escapeHtml(exp.description)}</td>
              <td>${formatCurrency(exp.amount)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      `;
      expensesCard.appendChild(table);
    } else {
      expensesCard.innerHTML += '<p>Расходов пока нет.</p>';
    }
    container.appendChild(expensesCard);
    // Форма добавления расхода
    const addExpenseCard = document.createElement('div');
    addExpenseCard.className = 'card';
    addExpenseCard.innerHTML = `
      <h2>Добавить расход</h2>
      <form id="add-expense-form">
        <label>Плательщик
          <select name="payer_id" required>
            ${trip.participants.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}
          </select>
        </label>
        <label>Сумма
          <input type="number" name="amount" required step="0.01" min="0" placeholder="0.00">
        </label>
        <label>Описание
          <input type="text" name="description" required placeholder="За что?">
        </label>
        <label>Дата
          <input type="date" name="date" value="${state.lastExpenseDate}">
        </label>
        <label>Тип дележа
          <select name="split_type">
            <option value="equal">Поровну</option>
            <option value="custom">Свои доли</option>
          </select>
        </label>
        <div id="custom-shares" style="display:none;width:100%;">
          <p>Укажите долю для каждого участника:</p>
          ${trip.participants.map(p => {
            return `<label style="flex:1 1 120px;">${escapeHtml(p.name)}
              <input type="number" name="share_${p.id}" step="0.01" min="0" placeholder="0.00">
            </label>`;
          }).join('')}
        </div>
        <button type="submit" class="btn">Добавить расход</button>
      </form>
    `;
    container.appendChild(addExpenseCard);
    // Форма добавления перевода
    const addTransferCard = document.createElement('div');
    addTransferCard.className = 'card';
    addTransferCard.innerHTML = `
      <h2>Добавить перевод</h2>
      <form id="add-transfer-form">
        <label>От
          <select name="from_id" required>
            ${trip.participants.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}
          </select>
        </label>
        <label>Кому
          <select name="to_id" required>
            ${trip.participants.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}
          </select>
        </label>
        <label>Сумма
          <input type="number" name="amount" required step="0.01" min="0" placeholder="0.00">
        </label>
        <label>Дата
          <input type="date" name="date" value="${state.lastExpenseDate}">
        </label>
        <button type="submit" class="btn">Добавить перевод</button>
      </form>
    `;
    container.appendChild(addTransferCard);
    // Матрица задолженностей
    const matrixCard = document.createElement('div');
    matrixCard.className = 'card';
    matrixCard.innerHTML = '<h2>Матрица задолженностей</h2>';
    const matrixDiv = document.createElement('div');
    matrixDiv.className = 'matrix-table';
    const matrix = trip.debt_matrix || {};
    const participants = trip.participants;
    let matrixTable = '<table><thead><tr><th>\u2192/\u2193</th>';
    participants.forEach(col => {
      matrixTable += `<th>${escapeHtml(col.name)}</th>`;
    });
    matrixTable += '</tr></thead><tbody>';
    participants.forEach(row => {
      matrixTable += `<tr><th>${escapeHtml(row.name)}</th>`;
      participants.forEach(col => {
        if (row.id === col.id) {
          matrixTable += '<td>—</td>';
        } else {
          const amount = (matrix[row.id] && matrix[row.id][col.id]) || 0;
          const formatted = amount > 0 ? formatCurrency(amount) : '';
          const clickable = amount > 0 ? 'clickable' : '';
          matrixTable += `<td class="${clickable}" data-from="${row.id}" data-to="${col.id}" data-amount="${amount}">${formatted}</td>`;
        }
      });
      matrixTable += '</tr>';
    });
    matrixTable += '</tbody></table>';
    matrixDiv.innerHTML = matrixTable;
    matrixCard.appendChild(matrixDiv);
    container.appendChild(matrixCard);
    // Модальное окно для перевода (скрыто по умолчанию)
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal-content">
        <h3>Добавить перевод</h3>
        <form id="modal-transfer-form">
          <input type="hidden" name="from_id">
          <input type="hidden" name="to_id">
          <label>Сумма
            <input type="number" name="amount" required step="0.01" min="0" placeholder="0.00">
          </label>
          <label>Дата
            <input type="date" name="date" value="${state.lastExpenseDate}">
          </label>
          <button type="submit" class="btn">Добавить перевод</button>
          <button type="button" class="btn btn-secondary" id="modal-cancel">Отмена</button>
        </form>
      </div>
    `;
    container.appendChild(modal);
    // Вставляем контейнер
    appEl.innerHTML = '';
    appEl.appendChild(container);
    // Обработчики форм и событий
    // Добавление участника
    const addParticipantForm = container.querySelector('#add-participant-form');
    addParticipantForm.addEventListener('submit', async ev => {
      ev.preventDefault();
      const fd = new FormData(addParticipantForm);
      const name = fd.get('name').trim();
      if (!name) return;
      try {
        await apiRequest('POST', `/api/trips/${trip.id}/participants`, { name });
        await loadTrip(trip.id);
      } catch (err) {
        alert('Ошибка при добавлении участника: ' + err.message);
      }
    });
    // Настройка смены типа дележа
    const splitSelect = container.querySelector('select[name="split_type"]');
    const customSharesDiv = container.querySelector('#custom-shares');
    splitSelect.addEventListener('change', () => {
      if (splitSelect.value === 'custom') {
        customSharesDiv.style.display = '';
      } else {
        customSharesDiv.style.display = 'none';
      }
    });
    // Добавление расхода
    const addExpenseForm = container.querySelector('#add-expense-form');
    addExpenseForm.addEventListener('submit', async ev => {
      ev.preventDefault();
      const fd = new FormData(addExpenseForm);
      const payer_id = fd.get('payer_id');
      const amount = parseFloat(fd.get('amount'));
      const description = fd.get('description').trim();
      const date = fd.get('date') || null;
      const splitType = fd.get('split_type');
      const body = {
        payer_id,
        amount,
        description,
        date: date || undefined,
      };
      if (splitType === 'custom') {
        const shares = [];
        let total = 0;
        trip.participants.forEach(p => {
          const shareField = fd.get(`share_${p.id}`);
          const shareVal = shareField ? parseFloat(shareField) : 0;
          if (isNaN(shareVal)) return;
          if (shareVal > 0) {
            shares.push({ participant_id: p.id, amount: shareVal });
            total += shareVal;
          }
        });
        body.shares = shares;
      }
      try {
        await apiRequest('POST', `/api/trips/${trip.id}/expenses`, body);
        await loadTrip(trip.id);
      } catch (err) {
        alert('Ошибка при добавлении расхода: ' + err.message);
      }
    });
    // Добавление перевода
    const addTransferForm = container.querySelector('#add-transfer-form');
    addTransferForm.addEventListener('submit', async ev => {
      ev.preventDefault();
      const fd = new FormData(addTransferForm);
      const from_id = fd.get('from_id');
      const to_id = fd.get('to_id');
      const amount = parseFloat(fd.get('amount'));
      const date = fd.get('date') || null;
      if (from_id === to_id) {
        alert('Нельзя переводить средства самому себе');
        return;
      }
      try {
        await apiRequest('POST', `/api/trips/${trip.id}/transfers`, { from_id, to_id, amount, date: date || undefined });
        await loadTrip(trip.id);
      } catch (err) {
        alert('Ошибка при добавлении перевода: ' + err.message);
      }
    });
    // Обработчики кликов по матрице
    const matrixCells = container.querySelectorAll('.matrix-table td.clickable');
    matrixCells.forEach(cell => {
      cell.addEventListener('click', () => {
        const from = cell.getAttribute('data-from');
        const to = cell.getAttribute('data-to');
        const amount = parseFloat(cell.getAttribute('data-amount')) || 0;
        openModal(from, to, amount);
      });
    });
    // Модальное окно и форма в нём
    const modalEl = modal;
    const modalForm = modalEl.querySelector('#modal-transfer-form');
    const cancelBtn = modalEl.querySelector('#modal-cancel');
    cancelBtn.addEventListener('click', () => closeModal());
    modalForm.addEventListener('submit', async ev => {
      ev.preventDefault();
      const fd = new FormData(modalForm);
      const from_id = fd.get('from_id');
      const to_id = fd.get('to_id');
      const amount = parseFloat(fd.get('amount'));
      const date = fd.get('date') || null;
      if (from_id === to_id) {
        alert('Нельзя переводить средства самому себе');
        return;
      }
      try {
        await apiRequest('POST', `/api/trips/${trip.id}/transfers`, { from_id, to_id, amount, date: date || undefined });
        closeModal();
        await loadTrip(trip.id);
      } catch (err) {
        alert('Ошибка при добавлении перевода: ' + err.message);
      }
    });
    // Функции для модального окна
    function openModal(fromId, toId, amount) {
      modalEl.classList.add('active');
      // Заполнить скрытые поля и сумму
      modalForm.elements['from_id'].value = fromId;
      modalForm.elements['to_id'].value = toId;
      modalForm.elements['amount'].value = amount.toFixed(2);
      modalForm.elements['date'].value = state.lastExpenseDate;
    }
    function closeModal() {
      modalEl.classList.remove('active');
    }
  }

  /**
   * Отображает сообщение об ошибке на странице.
   */
  function renderError(message) {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'card';
    errorDiv.innerHTML = `<p style="color: var(--color-danger);">Ошибка: ${escapeHtml(message)}</p>`;
    appEl.innerHTML = '';
    appEl.appendChild(errorDiv);
  }

  /**
   * Форматирует дату в удобный для человека вид (дд.мм.гггг).
   */
  function formatDate(dateStr) {
    const [y, m, d] = dateStr.split('-');
    return `${d}.${m}.${y}`;
  }

  /**
   * Форматирует число как денежную сумму в рублях с двумя знаками после
   * запятой.
   */
  function formatCurrency(value) {
    return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', minimumFractionDigits: 2 }).format(value);
  }

  /**
   * Экранирует специальные HTML‑символы, чтобы предотвратить XSS.
   */
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, s => {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[s];
    });
  }

  // Запуск
  init();
})();