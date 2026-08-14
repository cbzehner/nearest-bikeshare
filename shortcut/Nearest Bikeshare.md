# Nearest Bikeshare Shortcut

Build this personal Shortcut after deploying the Worker. Replace `WORKER_URL` with the deployed URL without a trailing slash.

1. Add **Get Current Location**.
2. Add **Get Details of Locations** twice. Get `Latitude` from the current location, then `Longitude` from the current location.
3. Add a **Text** action with this value. Insert the latitude and longitude variables in the marked positions:

   ```text
   WORKER_URL/nearest?lat=LATITUDE&lon=LONGITUDE&type=any
   ```

4. Add **Get Contents of URL**. Set the method to `GET` and use the Text action as the URL.
5. Add **Get Dictionary Value** for `spokenMessage`, using the contents of the URL as the dictionary.
6. Add **Speak Text** using `spokenMessage`. This keeps the distance unit and singular/plural wording together.
7. Add **Get Dictionary Value** for `appleMapsPreviewUrl`, using the contents of the URL as the dictionary.
8. Add **Open URLs** using `appleMapsPreviewUrl`. This always opens the map preview for the exact selected bike or station.

The response also includes `googleMapsPreviewUrl`. To use Google Maps instead, read that key in step 7. Google Maps opens the preview in its app when it is installed, or in the browser otherwise.

If **Get Contents of URL** reports an error, speak: `Bay Wheels data is temporarily unavailable. Try again in a moment.`
