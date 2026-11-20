# Adaptive Home Comfort

Adaptive Home Comfort for Homey Pro sets the temperature of each heating zone. It decides from
three things: whether someone is home, the energy price and the outdoor temperature. There is
no weekly schedule. Your flows only tell the app what is going on.

A hot tub or a hot water tank can be added too: the app heats its water in the cheapest hours
before you need it.

Not in the Homey App Store for now: install it with the Homey CLI (below). Discuss it in the
[community topic](https://community.homey.app/t/161500).

## Install

You need a Homey Pro (Early 2023) or newer, or Homey Self-Hosted Server, and a computer with [Node.js](https://nodejs.org) and the
[Homey CLI](https://apps.developer.homey.app/the-basics/getting-started/homey-cli).

```sh
npm install --global homey
homey login
git clone https://github.com/oh2th-homey/fi.oh2th.home-comfort.git
cd fi.oh2th.home-comfort
npm install
homey select
homey app install
```

`homey select` chooses the Homey to install on. To update, run `git pull`, `npm install` and
`homey app install` again: devices and settings are kept.

## Contents

- [Setup](Setup): what to add first.
- [Home Controller](Home-Controller): the shared state for all zones.
- [Heating Zone](Heating-Zone): one room or area.
- [Zone devices](Zone-devices): thermostats, relays, air conditioners, sensors, windows.
- [Hot Tub and Water Heater](Hot-Tub-and-Water-Heater): heat stored water in the cheapest hours.
- [Sauna](Sauna): follow a sauna session.
- [Water Monitor](Water-Monitor): the home's water use and cost.
- [Prices](Prices): energy prices from Power by the Hour.
- [Graphs](Graphs): today and tomorrow as images on the devices.
- [Flow cards](Flow-cards): the cards the app adds.
- [How to](How-to): presence, guests, price peaks, relays, air conditioners and more.
- [Troubleshooting](Troubleshooting)
