# WhatsMess - Komunikatory w jednym oknie na macOS

WhatsMess to darmowa aplikacja desktopowa na macOS, ktora laczy Facebooka Messenger i WhatsApp w jednym wygodnym oknie. Zbudowana w oparciu o Electron, zapewnia natywne powiadomienia systemowe, szybkie przelaczanie miedzy komunikatorami i nowoczesny, ciemny interfejs.

---

## Zrzuty ekranu

![Ekran glowny](screenshots/4.png)

![Widok rozmowy](screenshots/3.png)

![Przelaczanie komunikatorow](screenshots/2.png)

![Konfiguracja](screenshots/1.png)

---

## Funkcje

- **Messenger i WhatsApp w jednej aplikacji** - nie musisz juz przeskakiwac miedzy przegladarka a osobnymi oknami. Wszystkie rozmowy sa dostepne w jednym miejscu.
- **Natywne powiadomienia macOS** - aplikacja wysyla powiadomienia systemowe o nowych wiadomosciach. Klikniecie powiadomienia przenosi do odpowiedniej zakladki.
- **Zarzadzanie uprawnieniami powiadomien** - wbudowany przycisk do wymuszenia zapytania systemowego o pozwolenie na powiadomienia oraz szybki dostep do ustawien systemowych.
- **Ciemny interfejs** - nowoczesny, minimalistyczny design dopasowany do systemu macOS.
- **Zakladki z licznikami** - widoczna liczba nieprzeczytanych wiadomosci dla kazdego komunikatora.
- **Niezalezne sesje** - kazdy komunikator dziala w oddzielnej sesji, co oznacza niezalezne logowanie i przechowywanie danych.
- **Konfiguracja przy pierwszym uruchomieniu** - kreator pozwala wybrac, ktore komunikatory chcesz uzywac.
- **Praca w tle** - zamkniecie okna minimalizuje aplikacje do Docka zamiast ja konczyc.

---

## Wymagania systemowe

- macOS 10.13 (High Sierra) lub nowszy
- Architektura Apple Silicon (arm64) lub Intel (x64)

---

## Instalacja

### Gotowa paczka DMG

1. Pobierz najnowszy plik DMG z zakladki [Releases](https://github.com/k0rdian/WhatsMess/releases).
2. Otworz plik DMG i przeciagnij aplikacje do folderu Aplikacje.
3. Uruchom WhatsMess z Launchpada lub folderu Aplikacje.

Uwaga: przy pierwszym uruchomieniu macOS moze wyswietlic ostrzezenie o nieznanym deweloperze. Aby je ominac, kliknij prawym przyciskiem myszy na aplikacje i wybierz "Otworz".

### Budowanie ze zrodla

```bash
git clone https://github.com/k0rdian/WhatsMess.git
cd WhatsMess
npm install
npm run build:mac
```

Gotowy plik DMG znajdziesz w katalogu `dist/`.

---

## Uruchamianie w trybie deweloperskim

```bash
npm install
npm start
```

---

## Struktura projektu

```
WhatsMess/
├── build/                  # Zasoby budowania (ikony, uprawnienia)
│   ├── icon.icns           # Ikona aplikacji
│   └── entitlements.mac.plist
├── src/
│   ├── assets/             # Zasoby aplikacji
│   │   └── ikona.png       # Ikona wyswietlana w interfejsie
│   ├── main.js             # Proces glowny Electron
│   ├── preload.js          # Skrypt preload (most IPC)
│   ├── webview-preload.js  # Skrypt preload dla webview (przechwytywanie powiadomien)
│   ├── renderer.js         # Logika interfejsu
│   ├── index.html          # Struktura interfejsu
│   └── styles.css          # Style CSS
├── package.json
└── README.md
```

---

## Jak dzialaja powiadomienia

WhatsMess przechwytuje powiadomienia z Messengera i WhatsApp na dwa sposoby:

1. **Przechwytywanie API Notification** - skrypt wstrzykniety do webview nadpisuje natywny obiekt `Notification` przegladarki i przekazuje dane do procesu glownego Electron, ktory wyswietla natywne powiadomienie macOS.

2. **Monitorowanie tytulu strony** - aplikacja sledzi zmiany w tytule strony (np. "(3) Messenger"), wykrywa nowe nieprzeczytane wiadomosci i generuje powiadomienie.

Jesli macOS nie wyswietla powiadomien, wejdz w Ustawienia aplikacji i uzyj przycisku "Wymusz zapytanie o uprawnienia" w sekcji "Uprawnienia systemowe". Mozesz tez otworzyc ustawienia systemowe powiadomien bezposrednio z aplikacji.

---

## Ustawienia

Panel ustawien (ikona zebatki w prawym gornym rogu) pozwala na:

- Wlaczanie i wylaczanie poszczegolnych komunikatorow
- Zarzadzanie powiadomieniami dla kazdego komunikatora osobno
- Wymuszenie zapytania o uprawnienia do powiadomien systemowych
- Otwarcie ustawien systemowych macOS dotyczacych powiadomien

---

## Uzyte technologie

- [Electron](https://www.electronjs.org/) - framework do budowania aplikacji desktopowych z uzyciem technologii webowych
- [electron-builder](https://www.electron.build/) - narzedzie do pakowania i dystrybucji aplikacji Electron
- HTML, CSS, JavaScript - interfejs uzytkownika

---

## Licencja

Projekt udostepniony na licencji MIT. Szczegoly w pliku [LICENSE](LICENSE).

---

## Autor

Stworzone przez [k0rdian](https://github.com/k0rdian).
