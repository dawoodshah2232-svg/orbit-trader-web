/* shared/specs-loader.js — QuotesWare P0: single SymbolSpec source of truth (client).
 *
 * The canonical table is embedded below (GENERATED from shared/symbol-specs.json;
 * do not hand-edit the EMBEDDED block — regenerate and run tests/specs-parity.test.js,
 * which asserts embedded == JSON).
 *
 * Behavior:
 *  - Synchronously populates window.SPECS (normalized specs plus the legacy field
 *    aliases trader.html / manager.html / admin.html read) so existing UI code
 *    works unchanged on first paint.
 *  - Async read-through refresh: tries the PHP authority (server/api/specs.php),
 *    then the raw shared/symbol-specs.json file, then the localStorage cache.
 *    When the server version is newer than the embedded one, values are applied
 *    in place and cached. window.SpecsLoader.ready resolves when the attempt ends.
 *
 * Pages include this BEFORE their own inline scripts:
 *   <script src="../shared/specs-loader.js"></script>
 */
(function () {
"use strict";
var EMBEDDED = {"version":2,"updated_at":"2026-10-05T12:14:19.000Z","units":{"swap":"account-currency units per 1.0 lot per night (negative = trader pays)","stops_level":"points, where 1 point = pip_size","freeze_level":"points, where 1 point = pip_size","spread_points":"points, where 1 point = pip_size; null = not specified","tick_value":"profit-currency units per 1 tick per 1.0 lot","pip_value":"informational account-currency units per 1 pip per 1.0 lot"},"symbols":{"XAUUSDc":{"symbol":"XAUUSDc","description":"Gold vs US Dollar","asset_class":"metals","base_currency":"XAU","profit_currency":"USD","margin_currency":"USD","digits":2,"tick_size":0.01,"tick_value":1,"pip_size":0.1,"pip_value":10,"contract_size":100,"volume_min":0.01,"volume_max":50,"volume_step":0.01,"leverage":100,"stops_level":26,"freeze_level":0,"spread_points":26,"swap_long":-30,"swap_short":-15,"triple_swap_day":"wednesday","sessions":"24/5","price_basis":"bid","execution_mode":"market","trade_status":"enabled","note":"broker-typical placeholder; owner confirmation needed (admin had -120/+40)"},"PAXGUSDc":{"symbol":"PAXGUSDc","description":"PAX Gold token vs US Dollar","asset_class":"crypto","base_currency":"PAX","profit_currency":"GUS","margin_currency":"USD","digits":2,"tick_size":0.01,"tick_value":0.01,"pip_size":1,"pip_value":1,"contract_size":1,"volume_min":0.01,"volume_max":500,"volume_step":0.01,"leverage":100,"stops_level":50,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/7","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"BTCUSDc":{"symbol":"BTCUSDc","description":"Bitcoin vs US Dollar","asset_class":"crypto","base_currency":"BTC","profit_currency":"USD","margin_currency":"USD","digits":2,"tick_size":0.01,"tick_value":0.01,"pip_size":1,"pip_value":1,"contract_size":1,"volume_min":0.01,"volume_max":10,"volume_step":0.01,"leverage":100,"stops_level":1000,"freeze_level":0,"spread_points":1000,"swap_long":-50,"swap_short":-50,"triple_swap_day":"wednesday","sessions":"24/7","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"ETHUSDc":{"symbol":"ETHUSDc","description":"Ethereum vs US Dollar","asset_class":"crypto","base_currency":"ETH","profit_currency":"USD","margin_currency":"USD","digits":2,"tick_size":0.01,"tick_value":0.01,"pip_size":1,"pip_value":1,"contract_size":1,"volume_min":0.01,"volume_max":50,"volume_step":0.01,"leverage":100,"stops_level":100,"freeze_level":0,"spread_points":100,"swap_long":-50,"swap_short":-50,"triple_swap_day":"wednesday","sessions":"24/7","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"SOLUSDc":{"symbol":"SOLUSDc","description":"Solana vs US Dollar","asset_class":"crypto","base_currency":"SOL","profit_currency":"USD","margin_currency":"USD","digits":2,"tick_size":0.01,"tick_value":0.01,"pip_size":1,"pip_value":1,"contract_size":1,"volume_min":0.01,"volume_max":500,"volume_step":0.01,"leverage":100,"stops_level":30,"freeze_level":0,"spread_points":30,"swap_long":-50,"swap_short":-50,"triple_swap_day":"wednesday","sessions":"24/7","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"BNBUSDc":{"symbol":"BNBUSDc","description":"Binance Coin vs US Dollar","asset_class":"crypto","base_currency":"BNB","profit_currency":"USD","margin_currency":"USD","digits":2,"tick_size":0.01,"tick_value":0.01,"pip_size":1,"pip_value":1,"contract_size":1,"volume_min":0.01,"volume_max":500,"volume_step":0.01,"leverage":100,"stops_level":60,"freeze_level":0,"spread_points":60,"swap_long":-50,"swap_short":-50,"triple_swap_day":"wednesday","sessions":"24/7","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"XRPUSDc":{"symbol":"XRPUSDc","description":"Ripple vs US Dollar","asset_class":"crypto","base_currency":"XRP","profit_currency":"USD","margin_currency":"USD","digits":4,"tick_size":0.0001,"tick_value":0.0001,"pip_size":0.01,"pip_value":0.1,"contract_size":1,"volume_min":0.01,"volume_max":5000,"volume_step":0.01,"leverage":100,"stops_level":8,"freeze_level":0,"spread_points":8,"swap_long":-50,"swap_short":-50,"triple_swap_day":"wednesday","sessions":"24/7","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"EURUSDc":{"symbol":"EURUSDc","description":"Euro vs US Dollar","asset_class":"fx","base_currency":"EUR","profit_currency":"USD","margin_currency":"USD","digits":5,"tick_size":0.00001,"tick_value":1,"pip_size":0.0001,"pip_value":10,"contract_size":100000,"volume_min":0.01,"volume_max":100,"volume_step":0.01,"leverage":100,"stops_level":15,"freeze_level":0,"spread_points":15,"swap_long":-30,"swap_short":15,"triple_swap_day":"wednesday","sessions":"24/5","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"GBPUSDc":{"symbol":"GBPUSDc","description":"British Pound vs US Dollar","asset_class":"fx","base_currency":"GBP","profit_currency":"USD","margin_currency":"USD","digits":5,"tick_size":0.00001,"tick_value":1,"pip_size":0.0001,"pip_value":10,"contract_size":100000,"volume_min":0.01,"volume_max":100,"volume_step":0.01,"leverage":100,"stops_level":18,"freeze_level":0,"spread_points":18,"swap_long":-45,"swap_short":10,"triple_swap_day":"wednesday","sessions":"24/5","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"USDJPYc":{"symbol":"USDJPYc","description":"US Dollar vs Japanese Yen","asset_class":"fx","base_currency":"USD","profit_currency":"JPY","margin_currency":"USD","digits":3,"tick_size":0.001,"tick_value":100,"pip_size":0.01,"pip_value":10,"contract_size":100000,"volume_min":0.01,"volume_max":100,"volume_step":0.01,"leverage":100,"stops_level":15,"freeze_level":0,"spread_points":15,"swap_long":20,"swap_short":-60,"triple_swap_day":"wednesday","sessions":"24/5","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"USDCHFc":{"symbol":"USDCHFc","description":"US Dollar vs Swiss Franc","asset_class":"fx","base_currency":"USD","profit_currency":"CHF","margin_currency":"USD","digits":5,"tick_size":0.00001,"tick_value":1,"pip_size":0.0001,"pip_value":10,"contract_size":100000,"volume_min":0.01,"volume_max":100,"volume_step":0.01,"leverage":100,"stops_level":20,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/5","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"AUDUSDc":{"symbol":"AUDUSDc","description":"Australian Dollar vs US Dollar","asset_class":"fx","base_currency":"AUD","profit_currency":"USD","margin_currency":"USD","digits":5,"tick_size":0.00001,"tick_value":1,"pip_size":0.0001,"pip_value":10,"contract_size":100000,"volume_min":0.01,"volume_max":100,"volume_step":0.01,"leverage":100,"stops_level":20,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/5","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"USDCADc":{"symbol":"USDCADc","description":"US Dollar vs Canadian Dollar","asset_class":"fx","base_currency":"USD","profit_currency":"CAD","margin_currency":"USD","digits":5,"tick_size":0.00001,"tick_value":1,"pip_size":0.0001,"pip_value":10,"contract_size":100000,"volume_min":0.01,"volume_max":100,"volume_step":0.01,"leverage":100,"stops_level":20,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/5","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"NZDUSDc":{"symbol":"NZDUSDc","description":"New Zealand Dollar vs US Dollar","asset_class":"fx","base_currency":"NZD","profit_currency":"USD","margin_currency":"USD","digits":5,"tick_size":0.00001,"tick_value":1,"pip_size":0.0001,"pip_value":10,"contract_size":100000,"volume_min":0.01,"volume_max":100,"volume_step":0.01,"leverage":100,"stops_level":20,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/5","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"EURGBPc":{"symbol":"EURGBPc","description":"Euro vs British Pound","asset_class":"fx","base_currency":"EUR","profit_currency":"GBP","margin_currency":"USD","digits":5,"tick_size":0.00001,"tick_value":1,"pip_size":0.0001,"pip_value":10,"contract_size":100000,"volume_min":0.01,"volume_max":100,"volume_step":0.01,"leverage":100,"stops_level":20,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/5","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"EURJPYc":{"symbol":"EURJPYc","description":"Euro vs Japanese Yen","asset_class":"fx","base_currency":"EUR","profit_currency":"JPY","margin_currency":"USD","digits":3,"tick_size":0.001,"tick_value":100,"pip_size":0.01,"pip_value":10,"contract_size":100000,"volume_min":0.01,"volume_max":100,"volume_step":0.01,"leverage":100,"stops_level":20,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/5","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"EURCHFc":{"symbol":"EURCHFc","description":"Euro vs Swiss Franc","asset_class":"fx","base_currency":"EUR","profit_currency":"CHF","margin_currency":"USD","digits":5,"tick_size":0.00001,"tick_value":1,"pip_size":0.0001,"pip_value":10,"contract_size":100000,"volume_min":0.01,"volume_max":100,"volume_step":0.01,"leverage":100,"stops_level":20,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/5","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"EURAUDc":{"symbol":"EURAUDc","description":"Euro vs Australian Dollar","asset_class":"fx","base_currency":"EUR","profit_currency":"AUD","margin_currency":"USD","digits":5,"tick_size":0.00001,"tick_value":1,"pip_size":0.0001,"pip_value":10,"contract_size":100000,"volume_min":0.01,"volume_max":100,"volume_step":0.01,"leverage":100,"stops_level":20,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/5","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"EURCADc":{"symbol":"EURCADc","description":"Euro vs Canadian Dollar","asset_class":"fx","base_currency":"EUR","profit_currency":"CAD","margin_currency":"USD","digits":5,"tick_size":0.00001,"tick_value":1,"pip_size":0.0001,"pip_value":10,"contract_size":100000,"volume_min":0.01,"volume_max":100,"volume_step":0.01,"leverage":100,"stops_level":20,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/5","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"EURNZDc":{"symbol":"EURNZDc","description":"Euro vs New Zealand Dollar","asset_class":"fx","base_currency":"EUR","profit_currency":"NZD","margin_currency":"USD","digits":5,"tick_size":0.00001,"tick_value":1,"pip_size":0.0001,"pip_value":10,"contract_size":100000,"volume_min":0.01,"volume_max":100,"volume_step":0.01,"leverage":100,"stops_level":20,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/5","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"GBPJPYc":{"symbol":"GBPJPYc","description":"British Pound vs Japanese Yen","asset_class":"fx","base_currency":"GBP","profit_currency":"JPY","margin_currency":"USD","digits":3,"tick_size":0.001,"tick_value":100,"pip_size":0.01,"pip_value":10,"contract_size":100000,"volume_min":0.01,"volume_max":100,"volume_step":0.01,"leverage":100,"stops_level":20,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/5","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"GBPCHFc":{"symbol":"GBPCHFc","description":"British Pound vs Swiss Franc","asset_class":"fx","base_currency":"GBP","profit_currency":"CHF","margin_currency":"USD","digits":5,"tick_size":0.00001,"tick_value":1,"pip_size":0.0001,"pip_value":10,"contract_size":100000,"volume_min":0.01,"volume_max":100,"volume_step":0.01,"leverage":100,"stops_level":20,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/5","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"GBPAUDc":{"symbol":"GBPAUDc","description":"British Pound vs Australian Dollar","asset_class":"fx","base_currency":"GBP","profit_currency":"AUD","margin_currency":"USD","digits":5,"tick_size":0.00001,"tick_value":1,"pip_size":0.0001,"pip_value":10,"contract_size":100000,"volume_min":0.01,"volume_max":100,"volume_step":0.01,"leverage":100,"stops_level":20,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/5","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"GBPCADc":{"symbol":"GBPCADc","description":"British Pound vs Canadian Dollar","asset_class":"fx","base_currency":"GBP","profit_currency":"CAD","margin_currency":"USD","digits":5,"tick_size":0.00001,"tick_value":1,"pip_size":0.0001,"pip_value":10,"contract_size":100000,"volume_min":0.01,"volume_max":100,"volume_step":0.01,"leverage":100,"stops_level":20,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/5","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"GBPNZDc":{"symbol":"GBPNZDc","description":"British Pound vs New Zealand Dollar","asset_class":"fx","base_currency":"GBP","profit_currency":"NZD","margin_currency":"USD","digits":5,"tick_size":0.00001,"tick_value":1,"pip_size":0.0001,"pip_value":10,"contract_size":100000,"volume_min":0.01,"volume_max":100,"volume_step":0.01,"leverage":100,"stops_level":20,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/5","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"AUDJPYc":{"symbol":"AUDJPYc","description":"Australian Dollar vs Japanese Yen","asset_class":"fx","base_currency":"AUD","profit_currency":"JPY","margin_currency":"USD","digits":3,"tick_size":0.001,"tick_value":100,"pip_size":0.01,"pip_value":10,"contract_size":100000,"volume_min":0.01,"volume_max":100,"volume_step":0.01,"leverage":100,"stops_level":20,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/5","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"AUDCHFc":{"symbol":"AUDCHFc","description":"Australian Dollar vs Swiss Franc","asset_class":"fx","base_currency":"AUD","profit_currency":"CHF","margin_currency":"USD","digits":5,"tick_size":0.00001,"tick_value":1,"pip_size":0.0001,"pip_value":10,"contract_size":100000,"volume_min":0.01,"volume_max":100,"volume_step":0.01,"leverage":100,"stops_level":20,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/5","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"AUDCADc":{"symbol":"AUDCADc","description":"Australian Dollar vs Canadian Dollar","asset_class":"fx","base_currency":"AUD","profit_currency":"CAD","margin_currency":"USD","digits":5,"tick_size":0.00001,"tick_value":1,"pip_size":0.0001,"pip_value":10,"contract_size":100000,"volume_min":0.01,"volume_max":100,"volume_step":0.01,"leverage":100,"stops_level":20,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/5","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"AUDNZDc":{"symbol":"AUDNZDc","description":"Australian Dollar vs New Zealand Dollar","asset_class":"fx","base_currency":"AUD","profit_currency":"NZD","margin_currency":"USD","digits":5,"tick_size":0.00001,"tick_value":1,"pip_size":0.0001,"pip_value":10,"contract_size":100000,"volume_min":0.01,"volume_max":100,"volume_step":0.01,"leverage":100,"stops_level":20,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/5","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"CADJPYc":{"symbol":"CADJPYc","description":"Canadian Dollar vs Japanese Yen","asset_class":"fx","base_currency":"CAD","profit_currency":"JPY","margin_currency":"USD","digits":3,"tick_size":0.001,"tick_value":100,"pip_size":0.01,"pip_value":10,"contract_size":100000,"volume_min":0.01,"volume_max":100,"volume_step":0.01,"leverage":100,"stops_level":20,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/5","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"CADCHFc":{"symbol":"CADCHFc","description":"Canadian Dollar vs Swiss Franc","asset_class":"fx","base_currency":"CAD","profit_currency":"CHF","margin_currency":"USD","digits":5,"tick_size":0.00001,"tick_value":1,"pip_size":0.0001,"pip_value":10,"contract_size":100000,"volume_min":0.01,"volume_max":100,"volume_step":0.01,"leverage":100,"stops_level":20,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/5","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"NZDJPYc":{"symbol":"NZDJPYc","description":"New Zealand Dollar vs Japanese Yen","asset_class":"fx","base_currency":"NZD","profit_currency":"JPY","margin_currency":"USD","digits":3,"tick_size":0.001,"tick_value":100,"pip_size":0.01,"pip_value":10,"contract_size":100000,"volume_min":0.01,"volume_max":100,"volume_step":0.01,"leverage":100,"stops_level":20,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/5","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"NZDCHFc":{"symbol":"NZDCHFc","description":"New Zealand Dollar vs Swiss Franc","asset_class":"fx","base_currency":"NZD","profit_currency":"CHF","margin_currency":"USD","digits":5,"tick_size":0.00001,"tick_value":1,"pip_size":0.0001,"pip_value":10,"contract_size":100000,"volume_min":0.01,"volume_max":100,"volume_step":0.01,"leverage":100,"stops_level":20,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/5","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"CHFJPYc":{"symbol":"CHFJPYc","description":"Swiss Franc vs Japanese Yen","asset_class":"fx","base_currency":"CHF","profit_currency":"JPY","margin_currency":"USD","digits":3,"tick_size":0.001,"tick_value":100,"pip_size":0.01,"pip_value":10,"contract_size":100000,"volume_min":0.01,"volume_max":100,"volume_step":0.01,"leverage":100,"stops_level":20,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/5","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"USDSEKc":{"symbol":"USDSEKc","description":"US Dollar vs Swedish Krona","asset_class":"fx","base_currency":"USD","profit_currency":"SEK","margin_currency":"USD","digits":5,"tick_size":0.00001,"tick_value":1,"pip_size":0.0001,"pip_value":10,"contract_size":100000,"volume_min":0.01,"volume_max":100,"volume_step":0.01,"leverage":100,"stops_level":20,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/5","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"USDNOKc":{"symbol":"USDNOKc","description":"US Dollar vs Norwegian Krone","asset_class":"fx","base_currency":"USD","profit_currency":"NOK","margin_currency":"USD","digits":5,"tick_size":0.00001,"tick_value":1,"pip_size":0.0001,"pip_value":10,"contract_size":100000,"volume_min":0.01,"volume_max":100,"volume_step":0.01,"leverage":100,"stops_level":20,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/5","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"USDSGDc":{"symbol":"USDSGDc","description":"US Dollar vs Singapore Dollar","asset_class":"fx","base_currency":"USD","profit_currency":"SGD","margin_currency":"USD","digits":5,"tick_size":0.00001,"tick_value":1,"pip_size":0.0001,"pip_value":10,"contract_size":100000,"volume_min":0.01,"volume_max":100,"volume_step":0.01,"leverage":100,"stops_level":20,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/5","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"USDHKDc":{"symbol":"USDHKDc","description":"US Dollar vs Hong Kong Dollar","asset_class":"fx","base_currency":"USD","profit_currency":"HKD","margin_currency":"USD","digits":5,"tick_size":0.00001,"tick_value":1,"pip_size":0.0001,"pip_value":10,"contract_size":100000,"volume_min":0.01,"volume_max":100,"volume_step":0.01,"leverage":100,"stops_level":20,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/5","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"DOGEUSDc":{"symbol":"DOGEUSDc","description":"Dogecoin vs US Dollar","asset_class":"crypto","base_currency":"DOG","profit_currency":"EUS","margin_currency":"USD","digits":4,"tick_size":0.0001,"tick_value":0.0001,"pip_size":0.01,"pip_value":0.1,"contract_size":1,"volume_min":0.01,"volume_max":50000,"volume_step":0.01,"leverage":100,"stops_level":20,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/7","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"ADAUSDc":{"symbol":"ADAUSDc","description":"Cardano vs US Dollar","asset_class":"crypto","base_currency":"ADA","profit_currency":"USD","margin_currency":"USD","digits":4,"tick_size":0.0001,"tick_value":0.0001,"pip_size":0.01,"pip_value":0.1,"contract_size":1,"volume_min":0.01,"volume_max":50000,"volume_step":0.01,"leverage":100,"stops_level":20,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/7","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"AVAXUSDc":{"symbol":"AVAXUSDc","description":"Avalanche vs US Dollar","asset_class":"crypto","base_currency":"AVA","profit_currency":"XUS","margin_currency":"USD","digits":2,"tick_size":0.01,"tick_value":0.01,"pip_size":1,"pip_value":1,"contract_size":1,"volume_min":0.01,"volume_max":2000,"volume_step":0.01,"leverage":100,"stops_level":50,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/7","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"LINKUSDc":{"symbol":"LINKUSDc","description":"Chainlink vs US Dollar","asset_class":"crypto","base_currency":"LIN","profit_currency":"KUS","margin_currency":"USD","digits":2,"tick_size":0.01,"tick_value":0.01,"pip_size":1,"pip_value":1,"contract_size":1,"volume_min":0.01,"volume_max":5000,"volume_step":0.01,"leverage":100,"stops_level":50,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/7","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"TONUSDc":{"symbol":"TONUSDc","description":"Toncoin vs US Dollar","asset_class":"crypto","base_currency":"TON","profit_currency":"USD","margin_currency":"USD","digits":3,"tick_size":0.001,"tick_value":0.01,"pip_size":0.001,"pip_value":0.01,"contract_size":10,"volume_min":0.01,"volume_max":20000,"volume_step":0.01,"leverage":100,"stops_level":20,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/7","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"DOTUSDc":{"symbol":"DOTUSDc","description":"Polkadot vs US Dollar","asset_class":"crypto","base_currency":"DOT","profit_currency":"USD","margin_currency":"USD","digits":3,"tick_size":0.001,"tick_value":0.001,"pip_size":0.1,"pip_value":1,"contract_size":1,"volume_min":0.01,"volume_max":10000,"volume_step":0.01,"leverage":100,"stops_level":50,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/7","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"LTCUSDc":{"symbol":"LTCUSDc","description":"Litecoin vs US Dollar","asset_class":"crypto","base_currency":"LTC","profit_currency":"USD","margin_currency":"USD","digits":2,"tick_size":0.01,"tick_value":0.01,"pip_size":1,"pip_value":1,"contract_size":1,"volume_min":0.01,"volume_max":2000,"volume_step":0.01,"leverage":100,"stops_level":50,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/7","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"TRXUSDc":{"symbol":"TRXUSDc","description":"TRON vs US Dollar","asset_class":"crypto","base_currency":"TRX","profit_currency":"USD","margin_currency":"USD","digits":4,"tick_size":0.0001,"tick_value":0.0001,"pip_size":0.01,"pip_value":0.1,"contract_size":1,"volume_min":0.01,"volume_max":100000,"volume_step":0.01,"leverage":100,"stops_level":20,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/7","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"NEARUSDc":{"symbol":"NEARUSDc","description":"NEAR Protocol vs US Dollar","asset_class":"crypto","base_currency":"NEA","profit_currency":"RUS","margin_currency":"USD","digits":3,"tick_size":0.001,"tick_value":0.001,"pip_size":0.1,"pip_value":1,"contract_size":1,"volume_min":0.01,"volume_max":20000,"volume_step":0.01,"leverage":100,"stops_level":50,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/7","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"UNIUSDc":{"symbol":"UNIUSDc","description":"Uniswap vs US Dollar","asset_class":"crypto","base_currency":"UNI","profit_currency":"USD","margin_currency":"USD","digits":3,"tick_size":0.001,"tick_value":0.001,"pip_size":0.1,"pip_value":1,"contract_size":1,"volume_min":0.01,"volume_max":20000,"volume_step":0.01,"leverage":100,"stops_level":50,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/7","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"ATOMUSDc":{"symbol":"ATOMUSDc","description":"Cosmos vs US Dollar","asset_class":"crypto","base_currency":"ATO","profit_currency":"MUS","margin_currency":"USD","digits":3,"tick_size":0.001,"tick_value":0.001,"pip_size":0.1,"pip_value":1,"contract_size":1,"volume_min":0.01,"volume_max":20000,"volume_step":0.01,"leverage":100,"stops_level":50,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/7","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"ARBUSDc":{"symbol":"ARBUSDc","description":"Arbitrum vs US Dollar","asset_class":"crypto","base_currency":"ARB","profit_currency":"USD","margin_currency":"USD","digits":4,"tick_size":0.0001,"tick_value":0.0001,"pip_size":0.01,"pip_value":0.1,"contract_size":1,"volume_min":0.01,"volume_max":50000,"volume_step":0.01,"leverage":100,"stops_level":20,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/7","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"OPUSDc":{"symbol":"OPUSDc","description":"Optimism vs US Dollar","asset_class":"crypto","base_currency":"OPU","profit_currency":"SDc","margin_currency":"USD","digits":4,"tick_size":0.0001,"tick_value":0.0001,"pip_size":0.01,"pip_value":0.1,"contract_size":1,"volume_min":0.01,"volume_max":50000,"volume_step":0.01,"leverage":100,"stops_level":20,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/7","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"SUIUSDc":{"symbol":"SUIUSDc","description":"Sui vs US Dollar","asset_class":"crypto","base_currency":"SUI","profit_currency":"USD","margin_currency":"USD","digits":4,"tick_size":0.0001,"tick_value":0.0001,"pip_size":0.01,"pip_value":0.1,"contract_size":1,"volume_min":0.01,"volume_max":50000,"volume_step":0.01,"leverage":100,"stops_level":20,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/7","price_basis":"bid","execution_mode":"market","trade_status":"enabled"},"XAGUSDc":{"symbol":"XAGUSDc","description":"Silver vs US Dollar","asset_class":"metals","base_currency":"XAG","profit_currency":"USD","margin_currency":"USD","digits":3,"tick_size":0.001,"tick_value":5,"pip_size":0.001,"pip_value":5,"contract_size":5000,"volume_min":0.01,"volume_max":100,"volume_step":0.01,"leverage":100,"stops_level":20,"freeze_level":0,"spread_points":null,"swap_long":0,"swap_short":0,"triple_swap_day":"wednesday","sessions":"24/5","price_basis":"bid","execution_mode":"market","trade_status":"enabled"}},"v2_field_defaults":{"_comment":"Defaults applied by shared/specs-loader.js norm() when a symbol entry omits a v2 field. Optional fields; existing v1 fields unchanged.","isin":null,"international_name":null,"exchange":null,"category":null,"cfi":null,"sector":null,"industry":null,"country":null,"basis":null,"info_page":null,"chart_mode":"from price_basis (bid|last)","depth":0,"depth_volume_unit":"lots","spread_type":"derived: fixed when spread_points > 0 else floating","spread_balance":0,"trade_mode":"derived: full when trade_status=enabled else disabled","quote_source":null,"last_source":null,"quote_filter":{"mode":"accept_all","min_deviation":0,"max_deviation":0,"limit_deviation":0},"freeze_at_close":false,"calc_type":"enum: forex, forex_no_leverage, cfd, futures, cfd_index, cfd_leverage, exchange_stocks, exchange_bonds, exchange_futures, exchange_options, collateral; derived default: fx->forex, metals->cfd, crypto->cfd","gtc_mode":"good_till_canceled","max_quote_delay_sec":0,"filling_policies":["return"],"convert_profit":"by_deal","expirations":["gtc","day","specified_time","specified_day"],"orders_allowed":["market","limit","stop","stop_limit","sl","tp"],"volume_limit":0,"execution_mode":"market (existing; enum extended: instant|request|market|exchange)","instant_config":{"max_time_deviation_sec":0,"max_profit_deviation":0,"max_losing_deviation":0,"fast_requote_confirm":false},"request_config":{"timeout_sec":0,"dealer_confirm":false},"initial_margin":null,"maintenance_margin":null,"hedged_margin":null,"hedged_margin_larger_leg":false,"exclude_long_pnl_from_free_margin":false,"recalc_margin_fx_eod":false,"margin_check_on_sltp_trigger":false,"margin_rates":{"market_buy":1,"market_sell":1,"limit_buy":1,"limit_sell":1,"stop_buy":1,"stop_sell":1,"stop_limit_buy":1,"stop_limit_sell":1},"liquidity_margin_rate":null,"currency_margin_rate":null,"liquidity_rate":null,"swap_enabled":true,"swap_type":"money","swap_days_in_year":360,"swap_weekday_multipliers":"derived: triple_swap_day=3, sat/sun=0, rest=1","swap_holidays_auto":false,"session_calendar":null,"time_limits":{"from":null,"to":null}}};

function num(v, fb) { v = +v; return isFinite(v) ? v : fb; }

/* ---- v2 normalization helpers (schema version 2; additive defaults) ---- */
function normEnumArray(v, fb) {
  if (Array.isArray(v) && v.length) return v.map(String);
  return fb.slice();
}
function normQuoteFilter(v) {
  var d = { mode: "accept_all", min_deviation: 0, max_deviation: 0, limit_deviation: 0 };
  if (v && typeof v === "object") {
    if (typeof v.mode === "string") d.mode = v.mode;
    d.min_deviation = num(v.min_deviation, 0);
    d.max_deviation = num(v.max_deviation, 0);
    d.limit_deviation = num(v.limit_deviation, 0);
  }
  return d;
}
function normCalcType(assetClass) {
  if (assetClass === "fx") return "forex";
  if (assetClass === "metals") return "cfd";
  if (assetClass === "crypto") return "cfd";
  return "cfd";
}
/* Calculation-type enum (schema v2). An explicit value outside the enum falls
 * back to the asset-class derivation, so "collateral" and the other documented
 * types are accepted while typos never leak into the normalized spec. */
var CALC_TYPES = ["forex", "forex_no_leverage", "cfd", "futures", "cfd_index", "cfd_leverage",
  "exchange_stocks", "exchange_bonds", "exchange_futures", "exchange_options", "collateral"];
/* Broker-allowed margin-eligible share for collateral symbols: 0..1, clamped.
 * null = not specified (contributes nothing to equity until the broker sets it). */
function normLiquidityRate(v) {
  if (v == null) return null;
  v = +v;
  if (!isFinite(v)) return null;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
function normInstant(v) {
  var d = { max_time_deviation_sec: 0, max_profit_deviation: 0, max_losing_deviation: 0, fast_requote_confirm: false };
  if (v && typeof v === "object") {
    d.max_time_deviation_sec = num(v.max_time_deviation_sec, 0);
    d.max_profit_deviation = num(v.max_profit_deviation, 0);
    d.max_losing_deviation = num(v.max_losing_deviation, 0);
    d.fast_requote_confirm = !!v.fast_requote_confirm;
  }
  return d;
}
function normRequest(v) {
  var d = { timeout_sec: 0, dealer_confirm: false };
  if (v && typeof v === "object") {
    d.timeout_sec = num(v.timeout_sec, 0);
    d.dealer_confirm = !!v.dealer_confirm;
  }
  return d;
}
function normMarginRates(v) {
  var d = { market_buy: 1, market_sell: 1, limit_buy: 1, limit_sell: 1, stop_buy: 1, stop_sell: 1, stop_limit_buy: 1, stop_limit_sell: 1 };
  if (v && typeof v === "object") {
    for (var k in d) { if (v[k] != null) d[k] = +v[k]; }
  }
  return d;
}
function normSwapWeek(v, tripleDay) {
  var days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  var d = {}, td = String(tripleDay || "wednesday").toLowerCase();
  for (var i = 0; i < days.length; i++) {
    d[days[i]] = (days[i] === "saturday" || days[i] === "sunday") ? 0 : (days[i] === td ? 3 : 1);
  }
  if (v && typeof v === "object") {
    for (var j = 0; j < days.length; j++) { if (v[days[j]] != null) d[days[j]] = +v[days[j]]; }
  }
  return d;
}
function normTimeLimits(v) {
  var d = { from: null, to: null };
  if (v && typeof v === "object") {
    d.from = v.from == null ? null : String(v.from);
    d.to = v.to == null ? null : String(v.to);
  }
  return d;
}

/* Normalize one canonical entry -> rich object with canonical fields + the
 * legacy aliases every UI reads:
 *   trader.html : name/contract/pipSize/pipValue/minVol/maxVol/stepVol/stopsPts/session/kind
 *   manager.html: digits/contract/pipSize/pipValue/volMin/volMax/volStep/session/stops/swapL/swapS
 *   admin.html  : digits/contract/pipSize/pipValue/spread/minVol/maxVol/volStep/stopsLevel/session/swapLong/swapShort
 */
function norm(sym, r) {
  var digits = num(r.digits, 2);
  var o = {
    symbol: sym,
    description: r.description || sym,
    asset_class: r.asset_class || "fx",
    base_currency: r.base_currency || "",
    profit_currency: r.profit_currency || "",
    margin_currency: r.margin_currency || "USD",
    digits: digits,
    tick_size: num(r.tick_size, Math.pow(10, -digits)),
    tick_value: num(r.tick_value, 0),
    pip_size: num(r.pip_size, Math.pow(10, -digits)),
    pip_value: num(r.pip_value, 0),
    contract_size: num(r.contract_size, 1),
    volume_min: num(r.volume_min, 0.01),
    volume_max: num(r.volume_max, 100),
    volume_step: num(r.volume_step, 0.01),
    leverage: num(r.leverage, 100),
    stops_level: num(r.stops_level, 0),
    freeze_level: num(r.freeze_level, 0),
    spread_points: r.spread_points == null ? null : +r.spread_points,
    swap_long: num(r.swap_long, 0),
    swap_short: num(r.swap_short, 0),
    triple_swap_day: r.triple_swap_day || "wednesday",
    sessions: r.sessions || "",
    price_basis: r.price_basis || "bid",
    execution_mode: r.execution_mode || "market",
    trade_status: r.trade_status || "enabled"
  };
  /* ---- v2 fields (schema version 2; optional, defaults applied here) ---- */
  o.isin = r.isin == null ? null : String(r.isin);
  o.international_name = r.international_name == null ? null : String(r.international_name);
  o.exchange = r.exchange == null ? null : String(r.exchange);
  o.category = r.category == null ? null : String(r.category);
  o.cfi = r.cfi == null ? null : String(r.cfi);
  o.sector = r.sector == null ? null : String(r.sector);
  o.industry = r.industry == null ? null : String(r.industry);
  o.country = r.country == null ? null : String(r.country);
  o.basis = r.basis == null ? null : String(r.basis);
  o.info_page = r.info_page == null ? null : String(r.info_page);
  o.chart_mode = r.chart_mode || (o.price_basis === "last" ? "last" : "bid");
  o.depth = num(r.depth, 0);
  o.depth_volume_unit = r.depth_volume_unit || "lots";
  o.spread_type = r.spread_type || (o.spread_points != null && o.spread_points > 0 ? "fixed" : "floating");
  o.spread_balance = num(r.spread_balance, 0);
  o.trade_mode = r.trade_mode || (o.trade_status === "disabled" ? "disabled" : "full");
  o.quote_source = r.quote_source == null ? null : String(r.quote_source);
  o.last_source = r.last_source == null ? null : String(r.last_source);
  o.quote_filter = normQuoteFilter(r.quote_filter);
  o.freeze_at_close = !!r.freeze_at_close;
  o.calc_type = CALC_TYPES.indexOf(r.calc_type) >= 0 ? r.calc_type : normCalcType(o.asset_class);
  o.gtc_mode = r.gtc_mode || "good_till_canceled";
  o.max_quote_delay_sec = num(r.max_quote_delay_sec, 0);
  o.filling_policies = normEnumArray(r.filling_policies, ["return"]);
  o.convert_profit = r.convert_profit || "by_deal";
  o.expirations = normEnumArray(r.expirations, ["gtc", "day", "specified_time", "specified_day"]);
  o.orders_allowed = normEnumArray(r.orders_allowed, ["market", "limit", "stop", "stop_limit", "sl", "tp"]);
  o.volume_limit = num(r.volume_limit, 0);
  o.instant_config = normInstant(r.instant_config);
  o.request_config = normRequest(r.request_config);
  o.initial_margin = r.initial_margin == null ? null : +r.initial_margin;
  o.maintenance_margin = r.maintenance_margin == null ? null : +r.maintenance_margin;
  o.hedged_margin = r.hedged_margin == null ? null : +r.hedged_margin;
  o.hedged_margin_larger_leg = !!r.hedged_margin_larger_leg;
  o.exclude_long_pnl_from_free_margin = !!r.exclude_long_pnl_from_free_margin;
  o.recalc_margin_fx_eod = !!r.recalc_margin_fx_eod;
  o.margin_check_on_sltp_trigger = !!r.margin_check_on_sltp_trigger;
  o.margin_rates = normMarginRates(r.margin_rates);
  o.liquidity_margin_rate = r.liquidity_margin_rate == null ? null : +r.liquidity_margin_rate;
  o.currency_margin_rate = r.currency_margin_rate == null ? null : +r.currency_margin_rate;
  o.liquidity_rate = normLiquidityRate(r.liquidity_rate);
  o.swap_enabled = r.swap_enabled == null ? true : !!r.swap_enabled;
  o.swap_type = r.swap_type || "money";
  o.swap_days_in_year = num(r.swap_days_in_year, 360);
  o.swap_weekday_multipliers = normSwapWeek(r.swap_weekday_multipliers, o.triple_swap_day);
  o.swap_holidays_auto = !!r.swap_holidays_auto;
  o.session_calendar = r.session_calendar == null ? null : r.session_calendar;
  o.time_limits = normTimeLimits(r.time_limits);
  /* legacy aliases (kept so the three UIs need no changes) */
  o.name = o.description;
  o.contract = o.contract_size;
  o.pipSize = o.pip_size; o.pipValue = o.pip_value;
  o.minVol = o.volume_min; o.maxVol = o.volume_max; o.stepVol = o.volume_step;
  o.volMin = o.volume_min; o.volMax = o.volume_max; o.volStep = o.volume_step;
  o.stopsPts = o.stops_level; o.stops = o.stops_level; o.stopsLevel = o.stops_level;
  o.session = o.sessions;
  o.spread = o.spread_points;
  o.swapL = o.swap_long; o.swapS = o.swap_short;
  o.swapLong = o.swap_long; o.swapShort = o.swap_short;
  o.kind = o.asset_class === "fx" ? "fx" : "live";
  return o;
}

var SPECS = {};
var curVersion = 0;
function applyTable(doc) {
  if (!doc || !doc.symbols) return false;
  Object.keys(doc.symbols).forEach(function (sym) { SPECS[sym] = norm(sym, doc.symbols[sym]); });
  if (doc.version > curVersion) curVersion = doc.version;
  return true;
}
applyTable(EMBEDDED);

/* ---- environment-guarded helpers ---- */
function lsGet(k) { try { return typeof localStorage !== "undefined" ? localStorage.getItem(k) : null; } catch (e) { return null; } }
function lsSet(k, v) { try { if (typeof localStorage !== "undefined") localStorage.setItem(k, v); } catch (e) {} }
var CACHE_KEY = "qw-specs-cache-v1";

function endpoints() {
  var eps = [];
  try {
    var cs = typeof document !== "undefined" ? document.currentScript : null;
    var attr = cs && cs.getAttribute ? cs.getAttribute("data-specs-endpoint") : null;
    if (attr) eps.push(attr);
  } catch (e) {}
  var base = lsGet("qw-api-base");
  if (base) eps.push(String(base).replace(/\/+$/, "") + "/api/specs.php");
  try {
    if (typeof location !== "undefined" && /^https?:/.test(location.protocol || "")) {
      eps.push(new URL("../server/api/specs.php", location.href).toString());
    }
  } catch (e) {}
  return eps;
}
function jsonURL() {
  try {
    var cs = typeof document !== "undefined" ? document.currentScript : null;
    if (cs && cs.src) return new URL("symbol-specs.json", cs.src).toString();
    if (typeof location !== "undefined" && /^https?:/.test(location.protocol || "")) {
      return new URL("../shared/symbol-specs.json", location.href).toString();
    }
  } catch (e) {}
  return null;
}
function fetchJSON(url, ms) {
  if (typeof fetch === "undefined") return Promise.reject(new Error("no fetch"));
  var timer = null, ctrl = null;
  try {
    if (typeof AbortController !== "undefined") {
      ctrl = new AbortController();
      timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, ms || 5000);
    }
  } catch (e) {}
  var opts = ctrl ? { signal: ctrl.signal } : {};
  return fetch(url, opts).then(function (r) {
    if (!r.ok) throw new Error("http " + r.status);
    return r.json();
  }).then(function (d) { if (timer) clearTimeout(timer); return d; },
    function (e) { if (timer) clearTimeout(timer); throw e; });
}
function validDoc(d) { return d && typeof d.version === "number" && d.symbols && typeof d.symbols === "object"; }

function refresh() {
  var chain = Promise.reject(new Error("start"));
  endpoints().forEach(function (ep) {
    chain = chain.catch(function () {
      return fetchJSON(ep).then(function (d) {
        if (!validDoc(d)) throw new Error("bad doc");
        if (d.version > curVersion) {
          applyTable(d);
          lsSet(CACHE_KEY, JSON.stringify({ version: d.version, symbols: d.symbols, at: Date.now() }));
        }
        return true;
      });
    });
  });
  chain = chain.catch(function () {
    var ju = jsonURL();
    if (!ju) throw new Error("no json url");
    return fetchJSON(ju).then(function (d) {
      if (!validDoc(d)) throw new Error("bad doc");
      if (d.version > curVersion) applyTable(d);
      return true;
    });
  }).catch(function () {
    try {
      var c = JSON.parse(lsGet(CACHE_KEY) || "null");
      if (validDoc(c) && c.version > curVersion) { applyTable(c); return true; }
    } catch (e) {}
    return false;
  });
  return chain;
}

var ready = null;
try { ready = refresh(); } catch (e) { ready = Promise.resolve(false); }

var api = { ready: ready, refresh: refresh, version: function () { return curVersion; } };
if (typeof window !== "undefined") { window.SPECS = SPECS; window.SpecsLoader = api; }
if (typeof module !== "undefined" && module.exports) {
  module.exports = { SPECS: SPECS, SpecsLoader: api, _norm: norm, _embedded: EMBEDDED };
}
})();
