# Nearest Bikeshare Shortcut

Build this personal Shortcut after deploying the Worker. Replace `WORKER_URL` with the deployed URL without a trailing slash.

The installed Shortcut uses the built-in navy bicycle icon. The Grok-generated [icon concept](nearest-bikeshare.svg) is included for reference.

1. Add **Get Current Location**.
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
8. Add **Open URLs** using `appleMapsPreviewUrl`. This always opens the map preview for the exact selected bike or station.

The response also includes `googleMapsPreviewUrl` and `providerRentalUrl`. The default map setting reads `appleMapsPreviewUrl` in step 7. To use Google Maps, read `googleMapsPreviewUrl` instead. To open the official Bay Wheels rental link, read `providerRentalUrl` instead. If Lyft is installed, the provider link should open its Bay Wheels rental flow. The feed may provide a general scan or unlock link rather than a bike-specific app screen.

If **Get Contents of URL** reports an error, speak: `Bay Wheels data is temporarily unavailable. Try again in a moment.`
