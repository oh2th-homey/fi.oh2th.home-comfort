# Smart HVAC Control

Smart HVAC Control for Homey Pro sets the temperature of each heating zone. It decides from
three things: whether someone is home, the energy price and the outdoor temperature. There is
no weekly schedule. Your flows only tell the app what is going on.

> Status: not in the Homey App Store for now. Install it from this repository with the Homey CLI
> (see [Install](https://github.com/oh2th-homey/fi.oh2th.hvac-control/wiki/Home#install)). Discuss
> it in the [community topic](https://community.homey.app/t/161500).

## How to use

The user guide is in the
[wiki](https://github.com/oh2th-homey/fi.oh2th.hvac-control/wiki): setup, devices, prices,
flow cards, examples and troubleshooting.

In short:

1. Add the **HVAC Controller** (one per Homey). It holds occupancy, season, long absence, prices
   and the outdoor temperature.
2. Add a **Heating Zone** for each room or area, and pick its devices.
3. Make flows that tell the controller who is home. Energy prices come from Power by the Hour,
   chosen when you add the controller.
4. Optionally add a **Hot Tub** or a **Water Heater**: it heats the water in the cheapest hours
   before you need it, and your flows switch the heater on its Heating demand cards.

## License

GPL-3.0
