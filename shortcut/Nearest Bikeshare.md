# Nearest Bikeshare Shortcut

Deploy the Worker before you build this personal Shortcut. Replace `WORKER_URL` with the deployed Worker URL. Do not include a trailing slash.

Choose the built-in bicycle symbol and dark-blue color. The [icon concept](nearest-bikeshare.svg) is reference art. The Shortcut does not contain this custom image.

## Build the Shortcut

1. Add **Get Current Location** once.
2. Add **Get Details of Locations**. Select `Latitude` and use the current location as its input.
3. Add a second **Get Details of Locations**. Select `Longitude` and use the same current location as its input.
4. Add a **Text** action with this value:

   ```text
   WORKER_URL/nearest?lat=LATITUDE&lon=LONGITUDE&type=any&units=imperial&maps=apple
   ```

   Replace `LATITUDE` and `LONGITUDE` with the variables from the two location detail actions.

   Keep `units=imperial` for feet and miles. Change it to `units=metric` for meters and kilometers. This value stays in the Shortcut, so the Shortcut does not ask for units each time.

   Keep `maps=apple` to open Apple Maps. Change it to `maps=google` to open Google Maps.

5. Add **Get Contents of URL**. Use the Text action as the URL and set the method to `GET`.
6. Add **Get Dictionary Value**. Read `spokenMessage` from the contents of the URL.
7. Add **Speak Text**. Use `spokenMessage` as its input. This keeps the distance unit and singular or plural wording in one message.
8. Add **Get Dictionary Value**. Read `mapPreviewUrl` from the contents of the URL.
9. Add an **If** action. Set its condition to `Dictionary Value` **has any value**.
10. In the **If** branch, add **Open URLs**. Use `Dictionary Value` as its input.

The last action opens the selected map app at the exact bike or station. The `maps` value in the URL selects Apple Maps or Google Maps. Keep this value in the Shortcut. Do not ask for it during each run.

When the OpenRouteService key is available, the Worker compares walking distances for the ten closest candidates. The response uses `distanceSource=walking`. If routing is not available, it uses `distanceSource=straight_line` and marks the distance as approximate.

OpenRouteService ranks the candidates. Apple Maps or Google Maps may choose a different walking path when it opens.

The response also includes `providerRentalUrl`. Do not open it in this Shortcut. The live provider link usually opens a general scan flow, not details for one bike.

## No result or request failure

When no bike is available, `spokenMessage` explains the result and `mapPreviewUrl` is empty. The **If** action does not open Maps.

If **Get Contents of URL** reports a network or provider error, run the Shortcut again. The Worker supplies the no-results message only when it completes the request successfully.

Do not add another **Get Current Location** action. Do not add a final **Text** action with a provider URL.
