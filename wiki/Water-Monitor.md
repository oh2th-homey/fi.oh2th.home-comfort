# Water Monitor

A read-only device for the home's water: how many litres were used today and this month, what
they cost, and each use of water as it happens. It reads the house water meter and switches nothing.

## Add it

Add device → Adaptive Home Comfort → **Water Monitor**, then choose the **House water meter**: a
device of any app with Homey's standard **Water meter** (`meter_water`, m³) and/or **Water flow**
(`measure_water`, l/min).

- With both, the litres come from the meter reading and the uses from the flow.
- With the meter reading only, the litres are counted but there are no uses.
- With the flow only, the litres are counted from the flow.

Pick another meter in the device's **Repair**. Today's and this month's litres are kept.

## What it shows

- **Water today** (l) and **Water this month** (m³). They start from zero at midnight and on the
  first day of the month.
- **Water cost today** and **Water cost this month**, when a [water price or base fee](#settings)
  is set.
- **Flow** now (l/min).
- **Last use**: the use going on (*Running since 07:42: 12 l*) or the last one
  (*07:42–07:47: 38 l, 7.6 l/min*).

## Settings

- **Water price** (per m³): supply and wastewater together, as on the water bill (with VAT if you
  pay it). The litres are counted at this price, so a new price applies to the whole month.
- **Base fee** (per month): the bill's fixed fee, spread evenly over the month's days. Today's
  cost has one day's share; this month's cost has the shares of the days so far.

Both are in the Home Controller's currency; 0 leaves them out. A use's cost (**Water use ended**)
is its litres at the water price, without the base fee.

## Uses

A use starts when water starts running and ends a minute after it stops: a short pause in a
shower is still the same shower, while a washing machine's fills a few minutes apart are separate
uses. The meter sees all the home's water, so two uses at the same time (a tap while a shower runs)
count as one.

## Flow cards

- Trigger **Water use started** (flow).
- Trigger **Water use ended** (litres, minutes, average flow, cost; cost 0 without a water price).
- Homey's own cards for the water today and this month, the flow and the costs.
