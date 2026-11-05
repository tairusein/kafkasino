import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Language = 'en' | 'ru' | 'de';

const STORAGE_KEY = 'kafkasino.lang';

const TRANSLATIONS = {
  en: {
    // Navigation & Header
    'nav.home': 'Home',
    'nav.lobby': 'Lobby',
    'nav.tournaments': 'Tournaments',
    'nav.shop': 'Shop',
    'nav.profile': 'Profile',
    'nav.admin': 'Admin',
    'nav.signOut': 'Sign out',
    'nav.signIn': 'Sign in',
    'nav.register': 'Create account',
    'header.dailyBonus': 'Daily Bonus',
    'header.claiming': 'Claiming…',
    'header.bonusIn': 'Bonus in',
    'header.mute': 'Mute sound effects',
    'header.unmute': 'Unmute sound effects',
    'header.volume': 'Master volume',

    // Game Names
    'game.blackjack': 'Blackjack',
    'game.roulette': 'European Roulette',
    'game.slots': 'Vintage Slots',
    'game.poker': "Texas Hold'em",
    'game.durak': 'Durak',
    'game.chess': 'Royal Chess',
    'game.checkers': 'Checkers',

    // Home Page
    'home.eyebrow': 'House of Fortune · Grand Salon',
    'home.subtitle':
      'A private dark-gold salon for a discerning crowd. Seven authoritative games, live tables, and instant seat entry.',
    'home.enterLobby': 'Enter the Casino Floor',
    'home.viewProfile': 'Profile & Daily Bonus',
    'home.playersOnline': 'Players Online',
    'home.noOneOnline': 'Connecting to salon presence…',
    'home.you': '(you)',

    // Lobby Page
    'lobby.eyebrow': 'Grand Casino Floor',
    'lobby.title': 'Game Lobby',
    'lobby.chooseGame': 'Select a Game Table — Click OPEN to Play Instantly',
    'lobby.open': 'OPEN',
    'lobby.playNow': 'OPEN TABLE',
    'lobby.entering': 'ENTERING…',
    'lobby.playersRange': '{min}–{max} players',
    'lobby.singlePlayer': 'Solo Salon',
    'lobby.allGames': 'All Tables',
    'lobby.activeBannerEyebrow': 'You are currently seated at a table',
    'lobby.returnToTable': 'Return to Active Table',
    'lobby.hostEyebrow': 'Host a Table',
    'lobby.newRoom': 'Create Custom Room',
    'lobby.game': 'Game',
    'lobby.roomName': 'Room Name (Optional)',
    'lobby.visibility': 'Visibility',
    'lobby.publicRoom': 'Public (Listed in Lobby)',
    'lobby.privateRoom': 'Private (6-Char PIN)',
    'lobby.seats': 'Seats',
    'lobby.minBet': 'Min Bet (Chips)',
    'lobby.createAndEnter': 'Create & Enter Room',
    'lobby.creating': 'Creating…',
    'lobby.privateAccessEyebrow': 'Private Room Access',
    'lobby.havePin': 'Have a 6-Character Room PIN?',
    'lobby.enterPin': 'Enter PIN',
    'lobby.join': 'Join',
    'lobby.joining': 'Joining…',
    'lobby.openPublicRooms': 'Open Public Rooms',
    'lobby.showingOnly': 'Filtered by:',
    'lobby.showAll': 'Show All',
    'lobby.refresh': 'Refresh',
    'lobby.loadingRooms': 'Loading rooms…',
    'lobby.noOpenRooms': 'No open public rooms yet — click OPEN on any game card above to launch a table immediately.',
    'lobby.colRoom': 'Room',
    'lobby.colGame': 'Game',
    'lobby.colHost': 'Host',
    'lobby.colPlayers': 'Players',
    'lobby.colMinBet': 'Min Bet',
    'lobby.colStatus': 'Status',
    'lobby.colAction': 'Action',
    'lobby.reEnter': 'Re-enter',
    'lobby.seatFull': 'Full',
    'lobby.takeSeat': 'Seat',
    'lobby.status.waiting': 'waiting',
    'lobby.status.playing': 'playing',
    'lobby.status.finished': 'finished',

    // Game Room Common
    'room.privatePin': 'Private PIN Room',
    'room.publicTable': 'Public Salon Table',
    'room.roomPin': 'Room PIN',
    'room.copy': 'Copy',
    'room.copied': 'Copied',
    'room.inviteLink': '🔗 Invite Link',
    'room.linkCopied': '✓ Link Copied!',
    'room.minBet': 'Min Bet',
    'room.chips': 'Chips',
    'room.backToLobby': 'Lobby',
    'room.leaveTable': 'Leave Table',
    'room.afkEyebrow': 'Attention Required',
    'room.afkTitle': 'Your Turn Timed Out (15s) — Marked AFK',
    'room.afkDesc': 'The server automatically executed a safe default action to keep the table moving.',
    'room.returnFromAfk': 'I Am Back — Resume Play',
    'room.returning': 'Returning…',
    'room.chatTitle': 'Salon Chat',
    'room.chatPlaceholder': 'Message table…',
    'room.chatSend': 'Send',
    'room.chatEmpty': 'No messages yet. Wish the table good luck!',
    'room.emotesToggle': 'Emotes',
    'room.quickEmotes': 'Quick Emotes',
    'room.interactiveEmotes': 'Targeted Throwables',
    'room.buyInShop': 'Shop →',
    'room.seat': 'Seat',
    'room.host': 'Host',
    'room.you': '(You)',
    'room.acting': 'Acting',
    'room.spectating': 'Spectating',
    'room.targetEmote': '🎯 Throw Emote',
    'room.tableReady': 'Table Ready',
    'room.hand': 'Hand',
    'room.round': 'Round',
    'room.settled': 'Settled',
    'room.inPlay': 'In Play',
    'room.bettingOpen': 'Betting Open',
    'room.min': 'Min',
    'room.doubleWager': '2× Wager',
    'room.openTableBetting': 'Open Table Betting (15s)',

    // Blackjack
    'bj.dealerRules': 'House Croupier · Stands on All 17s',
    'bj.shoe': 'Shoe',
    'bj.placeWagerPrompt': 'Place your chips in the betting circle below to deal.',
    'bj.feltRibbon': 'BLACKJACK PAYS 3 TO 2 · DEALER MUST STAND ON ALL 17 · INSURANCE PAYS 2 TO 1',
    'bj.yourTurnBet': 'Your Turn to Place Bet',
    'bj.yourTurnAct': 'Your Turn to Act (Hit / Stand / Double)',
    'bj.awaitingBet': 'Awaiting {player}’s Bet',
    'bj.playerActing': '{player} is Acting',
    'bj.yourWager': 'Your Wager',
    'bj.dealing': 'Dealing…',
    'bj.confirmBet': 'Confirm Bet',
    'bj.dealHand': 'Deal Hand · Bet',
    'bj.hit': 'Hit (Draw)',
    'bj.stand': 'Stand (Hold)',
    'bj.doubleDown': 'Double Down',

    // Poker
    'poker.eyebrow': "No-Limit Texas Hold'em · 6-Max Casino Ring",
    'poker.blinds': 'Blinds',
    'poker.pot': 'Total Pot',
    'poker.highBet': 'Current Bet',
    'poker.dealNextHand': 'Deal Next Hand',
    'poker.dealing': 'Dealing…',
    'poker.waitingPlayers': 'Seat at least 2 players (or play heads-up) to deal.',
    'poker.yourTurn': 'Your Action on the Felt',
    'poker.fold': 'Fold',
    'poker.check': 'Check',
    'poker.call': 'Call',
    'poker.raiseTo': 'Raise to',
    'poker.allIn': 'All-In',

    // Roulette
    'rl.eyebrow': 'European Single-Zero Wheel · 97.30% RTP',
    'rl.payouts': 'Straight Up 35:1 · Dozens & Columns 2:1 · Even-Money 1:1',
    'rl.lastSpins': 'Last Spins:',
    'rl.noSpins': 'No spins yet',
    'rl.ballRolling': 'Ivory ball rolling on the mahogany track…',
    'rl.winningPocket': 'Winning Pocket · Spin',
    'rl.placeChipsPrompt': 'Select a chip denomination and click numbers or outside zones on the felt.',
    'rl.undo': 'Undo',
    'rl.clear': 'Clear',
    'rl.doubleSlip': '2× Slip',
    'rl.spinning': 'Spinning…',
    'rl.lockInBets': 'Lock In Bets',
    'rl.spinWheel': 'Spin Wheel · Bet',

    // Slots
    'slots.eyebrow': '3-Reel Mechanical Salon Cabinet · 96.55% RTP',
    'slots.title': 'Kafkasino Golden Reels',
    'slots.spinning': 'Spinning Reels…',
    'slots.pullLever': 'SPIN REELS',
    'slots.paytable': 'Official Paytable',

    // Durak
    'durak.eyebrow': '36-Card Podkidnoy Durak · Winner-Takes-Pot',
    'durak.talon': 'Talon',
    'durak.bita': 'Discard (Bita)',
    'durak.pot': 'Pot',
    'durak.dealBout': 'Deal New Bout',
    'durak.takeCards': 'Take All Cards',
    'durak.passBita': 'Pass / Done (Bita)',
    'durak.yourHand': 'Your Hand',

    // Board Games (Chess & Checkers)
    'board.chessTitle': 'Grandmaster Royal Chess · Match Stakes',
    'board.checkersTitle': 'Tournament Checkers (Draughts) · Mandatory Jump Rules',
    'board.startMatch': 'Start Match',
    'board.resign': 'Resign Match',
    'board.white': 'White',
    'board.black': 'Black',
    'board.red': 'Crimson',
  },
  ru: {
    // Navigation & Header
    'nav.home': 'Главная',
    'nav.lobby': 'Лобби',
    'nav.tournaments': 'Турниры',
    'nav.shop': 'Магазин',
    'nav.profile': 'Профиль',
    'nav.admin': 'Админ',
    'nav.signOut': 'Выйти',
    'nav.signIn': 'Войти',
    'nav.register': 'Регистрация',
    'header.dailyBonus': 'Бонус дня',
    'header.claiming': 'Получение…',
    'header.bonusIn': 'Бонус через',
    'header.mute': 'Выключить звук',
    'header.unmute': 'Включить звук',
    'header.volume': 'Громкость',

    // Game Names
    'game.blackjack': 'Блэкджек',
    'game.roulette': 'Европейская Рулетка',
    'game.slots': 'Золотые Слоты',
    'game.poker': 'Техасский Холдем',
    'game.durak': 'Подкидной Дурак',
    'game.chess': 'Королевские Шахматы',
    'game.checkers': 'Шашки',

    // Home Page
    'home.eyebrow': 'Дом Фортуны · Гранд Салон',
    'home.subtitle':
      'Закрытый элитный клуб в тёмно-золотых тонах. Семь классических игр казино и настольных дуэлей в реальном времени.',
    'home.enterLobby': 'Войти в Игровой Зал',
    'home.viewProfile': 'Профиль и Бонус',
    'home.playersOnline': 'Игроки онлайн',
    'home.noOneOnline': 'Подключение к залу…',
    'home.you': '(вы)',

    // Lobby Page
    'lobby.eyebrow': 'Главный Зал Казино',
    'lobby.title': 'Игровое Лобби',
    'lobby.chooseGame': 'Выберите игру — нажмите ОТКРЫТЬ для мгновенного входа за стол',
    'lobby.open': 'ОТКРЫТЬ',
    'lobby.playNow': 'ИГРАТЬ',
    'lobby.entering': 'ВХОД…',
    'lobby.playersRange': '{min}–{max} игроков',
    'lobby.singlePlayer': 'Соло-автомат',
    'lobby.allGames': 'Все столы',
    'lobby.activeBannerEyebrow': 'Вы сейчас находитесь за игровым столом',
    'lobby.returnToTable': 'Вернуться за стол',
    'lobby.hostEyebrow': 'Создать стол',
    'lobby.newRoom': 'Новая комната',
    'lobby.game': 'Игра',
    'lobby.roomName': 'Название стола (необязательно)',
    'lobby.visibility': 'Доступ',
    'lobby.publicRoom': 'Публичный (в общем списке)',
    'lobby.privateRoom': 'Приватный (по PIN-коду)',
    'lobby.seats': 'Мест',
    'lobby.minBet': 'Мин. ставка (фишки)',
    'lobby.createAndEnter': 'Создать и войти',
    'lobby.creating': 'Создание…',
    'lobby.privateAccessEyebrow': 'Вход в приватный зал',
    'lobby.havePin': 'Есть 6-значный PIN-код комнаты?',
    'lobby.enterPin': 'Введите PIN',
    'lobby.join': 'Войти',
    'lobby.joining': 'Вход…',
    'lobby.openPublicRooms': 'Открытые публичные столы',
    'lobby.showingOnly': 'Фильтр:',
    'lobby.showAll': 'Показать все',
    'lobby.refresh': 'Обновить',
    'lobby.loadingRooms': 'Загрузка столов…',
    'lobby.noOpenRooms': 'Открытых столов пока нет — нажмите «ОТКРЫТЬ» на любой карточке игры выше, чтобы мгновенно начать игру.',
    'lobby.colRoom': 'Стол',
    'lobby.colGame': 'Игра',
    'lobby.colHost': 'Хост',
    'lobby.colPlayers': 'Игроки',
    'lobby.colMinBet': 'Мин. ставка',
    'lobby.colStatus': 'Статус',
    'lobby.colAction': 'Действие',
    'lobby.reEnter': 'Вернуться',
    'lobby.seatFull': 'Мест нет',
    'lobby.takeSeat': 'Сесть за стол',
    'lobby.status.waiting': 'ожидание',
    'lobby.status.playing': 'в игре',
    'lobby.status.finished': 'завершена',

    // Game Room Common
    'room.privatePin': 'Приватный стол (PIN)',
    'room.publicTable': 'Публичный стол салона',
    'room.roomPin': 'PIN стола',
    'room.copy': 'Копировать',
    'room.copied': 'Скопировано',
    'room.inviteLink': '🔗 Пригласить',
    'room.linkCopied': '✓ Ссылка скопирована!',
    'room.minBet': 'Мин. ставка',
    'room.chips': 'Фишек',
    'room.backToLobby': 'В лобби',
    'room.leaveTable': 'Покинуть стол',
    'room.afkEyebrow': 'Внимание',
    'room.afkTitle': 'Время хода истекло (15 сек) — статус AFK',
    'room.afkDesc': 'Сервер автоматически выполнил безопасное действие, чтобы не задерживать стол.',
    'room.returnFromAfk': 'Я вернулся — продолжить игру',
    'room.returning': 'Возврат…',
    'room.chatTitle': 'Чат стола',
    'room.chatPlaceholder': 'Сообщение за стол…',
    'room.chatSend': 'Отпр.',
    'room.chatEmpty': 'Сообщений пока нет. Пожелайте удачи за столом!',
    'room.emotesToggle': 'Эмоции',
    'room.quickEmotes': 'Быстрые реплики',
    'room.interactiveEmotes': 'Интерактивные броски',
    'room.buyInShop': 'Магазин →',
    'room.seat': 'Место',
    'room.host': 'Хост',
    'room.you': '(Вы)',
    'room.acting': 'Ходит',
    'room.spectating': 'Наблюдает',
    'room.targetEmote': '🎯 Бросить предмет',
    'room.tableReady': 'Стол готов',
    'room.hand': 'Раздача',
    'room.round': 'Раунд',
    'room.settled': 'Завершён',
    'room.inPlay': 'В игре',
    'room.bettingOpen': 'Приём ставок',
    'room.min': 'Мин.',
    'room.doubleWager': '2× Ставка',
    'room.openTableBetting': 'Открыть ставки (15с)',

    // Blackjack
    'bj.dealerRules': 'Дилер казино · Останавливается на 17',
    'bj.shoe': 'Шуз',
    'bj.placeWagerPrompt': 'Выберите фишки и сделайте ставку, чтобы начать раздачу.',
    'bj.feltRibbon': 'БЛЭКДЖЕК ПЛАТИТ 3 К 2 · ДИЛЕР ОСТАНАВЛИВАЕТСЯ НА ВСЕХ 17 · 6 КОЛОД',
    'bj.yourTurnBet': 'Ваш ход — сделайте ставку',
    'bj.yourTurnAct': 'Ваш ход (Ещё / Хватит / Удвоить)',
    'bj.awaitingBet': 'Ожидание ставки {player}',
    'bj.playerActing': 'Ходит игрок {player}',
    'bj.yourWager': 'Ваша ставка',
    'bj.dealing': 'Раздача…',
    'bj.confirmBet': 'Подтвердить ставку',
    'bj.dealHand': 'Раздать · Ставка',
    'bj.hit': 'Ещё карту (Hit)',
    'bj.stand': 'Хватит (Stand)',
    'bj.doubleDown': 'Удвоить (Double)',

    // Poker
    'poker.eyebrow': 'Безлимитный Техасский Холдем · Казино-стол',
    'poker.blinds': 'Блайнды',
    'poker.pot': 'Банк (Pot)',
    'poker.highBet': 'Текущая ставка',
    'poker.dealNextHand': 'Раздать новую руку',
    'poker.dealing': 'Раздача…',
    'poker.waitingPlayers': 'Для начала раздачи нужны минимум 2 игрока за столом.',
    'poker.yourTurn': 'Ваш ход за покерным столом',
    'poker.fold': 'Пас (Fold)',
    'poker.check': 'Чек (Check)',
    'poker.call': 'Колл (Call)',
    'poker.raiseTo': 'Рейз до',
    'poker.allIn': 'Олл-ин (All-In)',

    // Roulette
    'rl.eyebrow': 'Европейская рулетка с одним зеро · RTP 97.30%',
    'rl.payouts': 'Прямая ставка 35:1 · Дюжины и Колонны 2:1 · Равные шансы 1:1',
    'rl.lastSpins': 'Последние числа:',
    'rl.noSpins': 'Пока нет спинов',
    'rl.ballRolling': 'Шарик вращается по треку рулетки…',
    'rl.winningPocket': 'Выигрышный сектор · Спин',
    'rl.placeChipsPrompt': 'Выберите номинал фишки и нажмите на сектора игрового поля.',
    'rl.undo': 'Отмена',
    'rl.clear': 'Очистить',
    'rl.doubleSlip': '2× Ставки',
    'rl.spinning': 'Вращение…',
    'rl.lockInBets': 'Принять ставки',
    'rl.spinWheel': 'Крутить колесо · Ставка',

    // Slots
    'slots.eyebrow': 'Классический 3-барабанный слот · RTP 96.55%',
    'slots.title': 'Золотые Барабаны Kafkasino',
    'slots.spinning': 'Вращение…',
    'slots.pullLever': 'КРУТИТЬ БАРАБАНЫ',
    'slots.paytable': 'Таблица выплат',

    // Durak
    'durak.eyebrow': 'Подкидной Дурак (36 карт) · Победитель забирает банк',
    'durak.talon': 'Прикуп',
    'durak.bita': 'Бита',
    'durak.pot': 'Банк',
    'durak.dealBout': 'Новая партия',
    'durak.takeCards': 'Беру карты',
    'durak.passBita': 'Бита / Пас',
    'durak.yourHand': 'Ваши карты',

    // Board Games
    'board.chessTitle': 'Королевские Шахматы · Игра на ставку стола',
    'board.checkersTitle': 'Классические Шашки · Обязательное взятие',
    'board.startMatch': 'Начать партию',
    'board.resign': 'Сдаться',
    'board.white': 'Белые',
    'board.black': 'Чёрные',
    'board.red': 'Красные',
  },
  de: {
    // Navigation & Header
    'nav.home': 'Start',
    'nav.lobby': 'Lobby',
    'nav.tournaments': 'Turniere',
    'nav.shop': 'Boutique',
    'nav.profile': 'Profil',
    'nav.admin': 'Admin',
    'nav.signOut': 'Abmelden',
    'nav.signIn': 'Anmelden',
    'nav.register': 'Registrieren',
    'header.dailyBonus': 'Tagesbonus',
    'header.claiming': 'Wird gebucht…',
    'header.bonusIn': 'Bonus in',
    'header.mute': 'Ton ausschalten',
    'header.unmute': 'Ton einschalten',
    'header.volume': 'Lautstärke',

    // Game Names
    'game.blackjack': 'Blackjack',
    'game.roulette': 'Europäisches Roulette',
    'game.slots': 'Goldene Slots',
    'game.poker': "Texas Hold'em",
    'game.durak': 'Durak (36 Karten)',
    'game.chess': 'Königliches Schach',
    'game.checkers': 'Dame',

    // Home Page
    'home.eyebrow': 'Haus des Glücks · Grand Salon',
    'home.subtitle':
      'Ein privater Salon in Schwarz und Gold für anspruchsvolle Spieler. Sieben klassische Casino- und Brettspiele in Echtzeit.',
    'home.enterLobby': 'Casino-Lobby betreten',
    'home.viewProfile': 'Profil & Tagesbonus',
    'home.playersOnline': 'Spieler Online',
    'home.noOneOnline': 'Verbinde mit dem Salon…',
    'home.you': '(Sie)',

    // Lobby Page
    'lobby.eyebrow': 'Großer Casino-Saal',
    'lobby.title': 'Spiel-Lobby',
    'lobby.chooseGame': 'Wählen Sie ein Spiel — Klicken Sie auf ÖFFNEN zum sofortigen Spielstart',
    'lobby.open': 'ÖFFNEN',
    'lobby.playNow': 'TISCH ÖFFNEN',
    'lobby.entering': 'BETRETE…',
    'lobby.playersRange': '{min}–{max} Spieler',
    'lobby.singlePlayer': 'Einzelspieler',
    'lobby.allGames': 'Alle Tische',
    'lobby.activeBannerEyebrow': 'Sie sitzen derzeit an einem aktiven Spieltisch',
    'lobby.returnToTable': 'Zurück zum Tisch',
    'lobby.hostEyebrow': 'Tisch eröffnen',
    'lobby.newRoom': 'Neuen Raum erstellen',
    'lobby.game': 'Spiel',
    'lobby.roomName': 'Tischname (Optional)',
    'lobby.visibility': 'Sichtbarkeit',
    'lobby.publicRoom': 'Öffentlich (in der Lobby sichtbar)',
    'lobby.privateRoom': 'Privat (6-stellige PIN)',
    'lobby.seats': 'Plätze',
    'lobby.minBet': 'Mindesteinsatz (Chips)',
    'lobby.createAndEnter': 'Erstellen & Betreten',
    'lobby.creating': 'Erstelle…',
    'lobby.privateAccessEyebrow': 'Privater Tischzugang',
    'lobby.havePin': 'Haben Sie eine 6-stellige Raum-PIN?',
    'lobby.enterPin': 'PIN eingeben',
    'lobby.join': 'Beitreten',
    'lobby.joining': 'Beitritt…',
    'lobby.openPublicRooms': 'Offene öffentliche Tische',
    'lobby.showingOnly': 'Gefiltert nach:',
    'lobby.showAll': 'Alle anzeigen',
    'lobby.refresh': 'Aktualisieren',
    'lobby.loadingRooms': 'Tische werden geladen…',
    'lobby.noOpenRooms': 'Noch keine offenen Tische — klicken Sie oben bei einem Spiel auf ÖFFNEN, um sofort zu starten.',
    'lobby.colRoom': 'Raum',
    'lobby.colGame': 'Spiel',
    'lobby.colHost': 'Gastgeber',
    'lobby.colPlayers': 'Spieler',
    'lobby.colMinBet': 'Min. Einsatz',
    'lobby.colStatus': 'Status',
    'lobby.colAction': 'Aktion',
    'lobby.reEnter': 'Eintreten',
    'lobby.seatFull': 'Voll',
    'lobby.takeSeat': 'Platz nehmen',
    'lobby.status.waiting': 'wartend',
    'lobby.status.playing': 'im Spiel',
    'lobby.status.finished': 'beendet',

    // Game Room Common
    'room.privatePin': 'Privater PIN-Raum',
    'room.publicTable': 'Öffentlicher Salontisch',
    'room.roomPin': 'Raum-PIN',
    'room.copy': 'Kopieren',
    'room.copied': 'Kopiert',
    'room.inviteLink': '🔗 Einladungslink',
    'room.linkCopied': '✓ Link kopiert!',
    'room.minBet': 'Mindesteinsatz',
    'room.chips': 'Chips',
    'room.backToLobby': 'Lobby',
    'room.leaveTable': 'Tisch verlassen',
    'room.afkEyebrow': 'Achtung',
    'room.afkTitle': 'Zeitüberschreitung (15s) — Als AFK markiert',
    'room.afkDesc': 'Der Server hat automatisch einen sicheren Zug ausgeführt, damit das Spiel weiterläuft.',
    'room.returnFromAfk': 'Ich bin zurück — Weiterspielen',
    'room.returning': 'Kehre zurück…',
    'room.chatTitle': 'Tisch-Chat',
    'room.chatPlaceholder': 'Nachricht an den Tisch…',
    'room.chatSend': 'Senden',
    'room.chatEmpty': 'Noch keine Nachrichten. Wünschen Sie dem Tisch viel Glück!',
    'room.emotesToggle': 'Emotes',
    'room.quickEmotes': 'Schnell-Emotes',
    'room.interactiveEmotes': 'Interaktive Würfe',
    'room.buyInShop': 'Shop →',
    'room.seat': 'Platz',
    'room.host': 'Host',
    'room.you': '(Sie)',
    'room.acting': 'Am Zug',
    'room.spectating': 'Zuschauer',
    'room.targetEmote': '🎯 Emote werfen',
    'room.tableReady': 'Tisch bereit',
    'room.hand': 'Hand',
    'room.round': 'Runde',
    'room.settled': 'Abgerechnet',
    'room.inPlay': 'Im Spiel',
    'room.bettingOpen': 'Einsätze offen',
    'room.min': 'Min',
    'room.doubleWager': '2× Einsatz',
    'room.openTableBetting': 'Einsatzrunde starten (15s)',

    // Blackjack
    'bj.dealerRules': 'Croupier des Hauses · Steht bei allen 17',
    'bj.shoe': 'Schlitten',
    'bj.placeWagerPrompt': 'Platzieren Sie Ihren Einsatz unten auf dem Filz, um zu geben.',
    'bj.feltRibbon': 'BLACKJACK ZAHLT 3 ZU 2 · CROUPIER STEHT BEI ALLEN 17 · 6 DECKS',
    'bj.yourTurnBet': 'Ihr Zug: Einsatz platzieren',
    'bj.yourTurnAct': 'Ihr Zug (Karte / Stehen / Verdoppeln)',
    'bj.awaitingBet': 'Warte auf Einsatz von {player}',
    'bj.playerActing': '{player} ist am Zug',
    'bj.yourWager': 'Ihr Einsatz',
    'bj.dealing': 'Karten werden gegeben…',
    'bj.confirmBet': 'Einsatz bestätigen',
    'bj.dealHand': 'Karten geben · Einsatz',
    'bj.hit': 'Karte ziehen (Hit)',
    'bj.stand': 'Stehen bleiben (Stand)',
    'bj.doubleDown': 'Verdoppeln (Double)',

    // Poker
    'poker.eyebrow': "No-Limit Texas Hold'em · 6-Max Casino-Tisch",
    'poker.blinds': 'Blinds',
    'poker.pot': 'Gesamtpot',
    'poker.highBet': 'Aktueller Einsatz',
    'poker.dealNextHand': 'Nächste Hand geben',
    'poker.dealing': 'Wird gegeben…',
    'poker.waitingPlayers': 'Mindestens 2 Spieler am Tisch erforderlich.',
    'poker.yourTurn': 'Sie sind am Zug',
    'poker.fold': 'Passen (Fold)',
    'poker.check': 'Schieben (Check)',
    'poker.call': 'Mitgehen (Call)',
    'poker.raiseTo': 'Erhöhen auf',
    'poker.allIn': 'All-In',

    // Roulette
    'rl.eyebrow': 'Europäisches Einzel-Zero-Kessel · 97,30% RTP',
    'rl.payouts': 'Plein 35:1 · Dutzende & Kolonnen 2:1 · Einfache Chancen 1:1',
    'rl.lastSpins': 'Letzte Zahlen:',
    'rl.noSpins': 'Noch keine Würfe',
    'rl.ballRolling': 'Elfenbeinkugel rollt im Kessel…',
    'rl.winningPocket': 'Gewinnzahl · Wurf',
    'rl.placeChipsPrompt': 'Wählen Sie einen Jeton und setzen Sie auf das Tableau.',
    'rl.undo': 'Zurück',
    'rl.clear': 'Löschen',
    'rl.doubleSlip': '2× Einsatz',
    'rl.spinning': 'Kessel dreht…',
    'rl.lockInBets': 'Einsätze bestätigen',
    'rl.spinWheel': 'Kessel drehen · Einsatz',

    // Slots
    'slots.eyebrow': 'Klassischer 3-Walzen-Salonautomat · 96,55% RTP',
    'slots.title': 'Kafkasino Goldene Walzen',
    'slots.spinning': 'Walzen drehen…',
    'slots.pullLever': 'WALZEN DREHEN',
    'slots.paytable': 'Auszahlungstabelle',

    // Durak
    'durak.eyebrow': '36-Karten Podkidnoy Durak · Gewinner erhält den Pot',
    'durak.talon': 'Talon',
    'durak.bita': 'Ablage (Bita)',
    'durak.pot': 'Pot',
    'durak.dealBout': 'Neue Runde geben',
    'durak.takeCards': 'Karten aufnehmen',
    'durak.passBita': 'Fertig / Bita',
    'durak.yourHand': 'Ihre Handkarten',

    // Board Games
    'board.chessTitle': 'Königliches Großmeister-Schach · Tisch-Einsatz',
    'board.checkersTitle': 'Turnier-Dame · Schlagzwang-Regeln',
    'board.startMatch': 'Partie starten',
    'board.resign': 'Aufgeben',
    'board.white': 'Weiß',
    'board.black': 'Schwarz',
    'board.red': 'Karminrot',
  },
} as const;

export type TranslationKey = keyof typeof TRANSLATIONS.en;

interface I18nContextValue {
  lang: Language;
  setLang: (lang: Language) => void;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
  gameName: (slug: string, fallback?: string) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function detectInitialLang(): Language {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'ru' || saved === 'de') {
      return saved;
    }
    const nav = navigator.language?.toLowerCase() ?? '';
    if (nav.startsWith('ru')) return 'ru';
    if (nav.startsWith('de')) return 'de';
  } catch {
    // ignore storage errors
  }
  return 'en';
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Language>(detectInitialLang);

  const setLang = useCallback((next: Language) => {
    setLangState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const t = useCallback(
    (key: TranslationKey, vars?: Record<string, string | number>): string => {
      const dict = (TRANSLATIONS[lang] ?? TRANSLATIONS.en) as Record<string, string>;
      const fallbackDict = TRANSLATIONS.en as Record<string, string>;
      let str: string = dict[key] ?? fallbackDict[key] ?? key;
      if (vars) {
        for (const [k, v] of Object.entries(vars)) {
          str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
        }
      }
      return str;
    },
    [lang],
  );

  const gameName = useCallback(
    (slug: string, fallback?: string): string => {
      const key = `game.${slug}`;
      const dict = (TRANSLATIONS[lang] ?? TRANSLATIONS.en) as Record<string, string>;
      if (key in dict) {
        return dict[key];
      }
      return fallback ?? slug;
    },
    [lang],
  );

  const value = useMemo(() => ({ lang, setLang, t, gameName }), [lang, setLang, t, gameName]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error('useI18n must be used inside <I18nProvider>');
  }
  return ctx;
}

export function LanguageSwitcher({ className = '' }: { className?: string }) {
  const { lang, setLang } = useI18n();
  const langs: { code: Language; label: string; title: string }[] = [
    { code: 'en', label: 'EN', title: 'English' },
    { code: 'ru', label: 'RU', title: 'Русский' },
    { code: 'de', label: 'DE', title: 'Deutsch' },
  ];

  return (
    <div className={`lang-switcher ${className}`.trim()} role="group" aria-label="Language selector">
      {langs.map((item) => (
        <button
          key={item.code}
          type="button"
          className={`lang-switcher__btn${lang === item.code ? ' is-active' : ''}`}
          onClick={() => setLang(item.code)}
          title={item.title}
          aria-pressed={lang === item.code}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
