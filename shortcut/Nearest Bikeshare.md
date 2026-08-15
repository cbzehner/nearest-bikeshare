# Nearest Bikeshare Shortcut

Build this personal Shortcut after deploying the Worker. Replace `WORKER_URL` with the deployed URL without a trailing slash.

Choose the built-in bicycle glyph and dark-blue color. The [icon concept](nearest-bikeshare.svg) is reference artwork only; this recipe does not embed a custom image in the Shortcut.

1. Add **Get Current Location**. Add this action only once. Use its output in both of the next actions.
2. Add **Get Details of Locations** twice. Get `Latitude` from the current location, then `Longitude` from the current location.
3. Add a **Text** action with this value. Insert the latitude and longitude variables in the marked positions:

   ```text
   WORKER_URL/nearest?lat=LATITUDE&lon=LONGITUDE&type=any&units=imperial
   ```

   Keep `units=imperial` for feet and miles, or change it to `units=metric` for meters and kilometers. This is a persistent setting in the Shortcut, so it does not prompt during normal use.

4. Add **Get Contents of URL**. Set the method to `GET` and use the Text action as the URL.
5. Add **Get Dictionary Value** for `spokenMessage`, using the contents of the URL as the dictionary.
6. Add **Speak Text** using `spokenMessage`. This keeps the distance unit and singular/plural wording together.
7. Add **Get Dictionary Value** for `appleMapsPreviewUrl`, using the contents of the URL as the dictionary.
8. Add an **If** action: `Dictionary Value` **has any value**.
9. Inside the **If** branch, add **Open URLs** using `Dictionary Value`. This opens the Apple Maps preview for the exact selected bike or station.

The response also includes `googleMapsPreviewUrl` and `providerRentalUrl` for other clients. This Shortcut intentionally opens only `appleMapsPreviewUrl`; the current provider link is usually a generic scan flow, not a bike-specific detail link.

When no bike is available, `spokenMessage` says so and `appleMapsPreviewUrl` is empty. The **If** action then skips Maps. Do not add a second **Get Current Location** action or a trailing **Text** action containing a provider URL.

If **Get Contents of URL** reports a network or provider error, retry the Shortcut. The Worker already supplies the useful no-results speech for successful responses with no available bike.
