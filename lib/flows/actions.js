'use strict';

exports.init = async function (ctx) {
  /**
   * HVAC Controller actions
   */
  const onAction_SET_ENUM_OCCUPANCY = ctx.homey.flow.getActionCard('set_enum_occupancy');
  onAction_SET_ENUM_OCCUPANCY.registerRunListener(async (args, state) => args.device.onAction_SET_ENUM_OCCUPANCY(args.occupancy));

  const onAction_END_LONG_ABSENCE = ctx.homey.flow.getActionCard('end_long_absence');
  onAction_END_LONG_ABSENCE.registerRunListener(async (args, state) => args.device.onAction_END_LONG_ABSENCE());

  const onAction_SET_ABSENCE_UNTIL = ctx.homey.flow.getActionCard('set_absence_until');
  onAction_SET_ABSENCE_UNTIL.registerRunListener(async (args, state) => args.device.onAction_SET_ABSENCE_UNTIL(args.date));

  /**
   * Heating Zone actions
   */
  const onAction_SET_ENUM_ZONE_MODE = ctx.homey.flow.getActionCard('set_enum_zone_mode');
  onAction_SET_ENUM_ZONE_MODE.registerRunListener(async (args, state) => args.device.onAction_SET_ENUM_ZONE_MODE(args.mode));

  const onAction_SET_POWER_BOOST = ctx.homey.flow.getActionCard('set_power_boost');
  onAction_SET_POWER_BOOST.registerRunListener(async (args, state) => args.device.onAction_SET_POWER_BOOST(args.minutes));

  const onAction_SET_TARGET_TEMPERATURE_COOL = ctx.homey.flow.getActionCard('set_target_temperature_cool');
  onAction_SET_TARGET_TEMPERATURE_COOL.registerRunListener(async (args, state) => args.device.onAction_SET_TARGET_TEMPERATURE_COOL(args.temperature));

  const onAction_ADD_NUM_FOLLOW_HOME_HOURS = ctx.homey.flow.getActionCard('add_num_follow_home_hours');
  onAction_ADD_NUM_FOLLOW_HOME_HOURS.registerRunListener(async (args, state) => args.device.onAction_ADD_NUM_FOLLOW_HOME_HOURS());

  const onAction_RESET_NUM_FOLLOW_HOME_HOURS = ctx.homey.flow.getActionCard('reset_num_follow_home_hours');
  onAction_RESET_NUM_FOLLOW_HOME_HOURS.registerRunListener(async (args, state) => args.device.onAction_RESET_NUM_FOLLOW_HOME_HOURS());

  const onAction_SET_TARGET_TEMPERATURE_COMFORT = ctx.homey.flow.getActionCard('set_target_temperature_comfort');
  onAction_SET_TARGET_TEMPERATURE_COMFORT.registerRunListener(async (args, state) => args.device.onAction_SET_TARGET_TEMPERATURE_COMFORT(args.temperature));

  const onAction_SET_TARGET_TEMPERATURE_ECO = ctx.homey.flow.getActionCard('set_target_temperature_eco');
  onAction_SET_TARGET_TEMPERATURE_ECO.registerRunListener(async (args, state) => args.device.onAction_SET_TARGET_TEMPERATURE_ECO(args.temperature));

  const onAction_SET_TARGET_TEMPERATURE_ECO_COOL = ctx.homey.flow.getActionCard('set_target_temperature_eco_cool');
  onAction_SET_TARGET_TEMPERATURE_ECO_COOL.registerRunListener(async (args, state) => args.device.onAction_SET_TARGET_TEMPERATURE_ECO_COOL(args.temperature));

  /**
   * Hot Tub and Water Heater actions
   */
  const onAction_WATER_READY_AT = ctx.homey.flow.getActionCard('water_ready_at');
  onAction_WATER_READY_AT.registerRunListener(async (args, state) => args.device.onAction_WATER_READY_AT(args.time, args.minutes));

  const onAction_WATER_SET_READY_TIME = ctx.homey.flow.getActionCard('water_set_ready_time');
  onAction_WATER_SET_READY_TIME.registerRunListener(async (args, state) => args.device.onAction_WATER_SET_READY_TIME(args));

  const onAction_SET_HEATING_READY = ctx.homey.flow.getActionCard('set_heating_ready');
  onAction_SET_HEATING_READY.registerRunListener(async (args, state) => args.device.onCapability_HEATING_READY(args.state === 'on'));

  const onAction_WATER_SKIP_NEXT = ctx.homey.flow.getActionCard('water_skip_next');
  onAction_WATER_SKIP_NEXT.registerRunListener(async (args, state) => args.device.onAction_WATER_SKIP_NEXT());

  const onAction_SET_WATER_TEMPERATURE = ctx.homey.flow.getActionCard('set_water_temperature');
  onAction_SET_WATER_TEMPERATURE.registerRunListener(async (args, state) => args.device.onAction_SET_WATER_TEMPERATURE(args.temperature));

  const onAction_SET_TANK_TEMPERATURE = ctx.homey.flow.getActionCard('set_tank_temperature');
  onAction_SET_TANK_TEMPERATURE.registerRunListener(async (args, state) => args.device.onAction_SET_TANK_TEMPERATURE(args.position, args.temperature));

  const onAction_SET_SAUNA_STOVE = ctx.homey.flow.getActionCard('set_sauna_stove');
  onAction_SET_SAUNA_STOVE.registerRunListener(async (args, state) => args.device.onAction_SET_SAUNA_STOVE(args.state));
};
