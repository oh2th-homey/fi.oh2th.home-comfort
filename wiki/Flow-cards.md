# Flow cards

Homey gives the standard cards for the standard parts of the devices: the season (thermostat
mode), the price now and Boost (on, off, toggle). The app adds these:

## HVAC Controller

- Actions: **Set occupancy**, **Set long absence until**, **End long absence**. **Import
  prices** is deprecated (see [Prices](Prices#import-prices-card-deprecated)).
- Conditions: **Occupancy is**, **Long absence is on**, **Price is expensive**.
- Triggers: **Occupancy changed**, **Long absence changed**, **Expensive now changed**, **Prices
  missing for tomorrow** (once a day at the check time). **Prices imported** is deprecated. The **Occupancy
  changed** token is `present`, `coming_home` or `away`.

## Heating Zone

- Actions: **Set zone mode**, **Boost zone** (for a number of minutes), **Set comfort heat**,
  **Set eco heat**, **Set comfort cool**, **Set eco cool**, **Follow home for 24 hours**, **Use own
  occupancy setting**.
- Conditions: **Zone mode is**, **Zone is in eco**.
- Triggers: **Eco changed**, **Target changed** (with the reason), **Member write failed**.

## Hot Tub and Water Heater

- Actions: **Ready at a time**, **Skip the next use**, **Turn heating ready on or off**,
  **Set water temperature** (when the water temperature comes from a flow, e.g. MQTT).
- Conditions: **Heating demand is active**, **Heating ready is on**, **State is**.
- Triggers: **Heating demand started** and **Heating demand stopped**, with the ready temperature
  and the reason; **State changed**, with the state; **Filter cycles planned** (Hot Tub, see
  [Filter cycles](Hot-Tub-and-Water-Heater#filter-cycles-hot-tub)), with each cycle's start and
  whether it runs. Homey's own cards cover the control (on/off) and the ready temperature.
