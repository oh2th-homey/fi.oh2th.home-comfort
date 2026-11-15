# Troubleshooting

- **"No temperature, off"**: the zone has relays but no working temperature sensor. Check that
  the sensor is available in Homey.
- **"Controller missing"**: the controller is unavailable or removed. After one hour the zones
  heat to comfort, ignore prices and show a problem.
- **Outdoor temperature is empty**: the sensor is unavailable or has not reported for 3 hours.
  Zones keep their last outdoor decision. Check the sensor, or pick another with Repair.
- **No new prices**: the controller's reason starts with `Power by the Hour:` and says why, for
  example it is not installed, older than version 9, or the chosen price device is gone. The
  prices it already has are kept. Update Power by the Hour, or choose another price device with
  Repair.
- **Prices rejected** (deprecated Import prices card only): the controller's reason says why, for
  example today's prices with too few values. The previous prices are kept.
- **A thermostat does not keep its setpoint, or falls back to 4 °C**: the zone writes it again,
  then tries once with a whole degree. If that fails too, the zone shows a problem, fires
  **Member write failed** and tries again later. If the device only takes whole degrees, set its
  **Step** to 1 in Repair.
- **Hot Tub or Water Heater: "No water temperature" and Heater problem**: the water temperature
  has not reported for 6 hours or its device is unavailable. Nothing is demanded until it reports
  again. If it comes from a virtual device, check the flow that updates it. With a power meter,
  Heater problem also comes on when heating has been demanded for 10 minutes without heating
  power: check that your flow on **Heating demand started** really turns the heater on.
- **Hot Tub or Water Heater heats much earlier than needed**: it is still learning and heats just
  in time with a slow starting estimate. Its settings show the learned values; after a day or two
  of heating and waiting it heats ahead in cheap hours instead.
- **Hot Tub or Water Heater: "No prices"**: the HVAC Controller has no prices. It heats just in
  time for each ready time until prices come back (a Water Heater also holds Keep).

To see what a zone is doing and why, check its **Reason**
(see [See why a zone does what it does](How-to#see-why-a-zone-does-what-it-does)).
