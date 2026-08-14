# Nearest Bikeshare Shortcut

Build this personal Shortcut after deploying the Worker. Replace `WORKER_URL` with the deployed URL without a trailing slash.

1. Add **Get Current Location**.
2. Add **Get Details of Locations** twice. Get `Latitude` from the current location, then `Longitude` from the current location.
3. Add **Ask for Input** with prompt `Bike type?`, input type `Text`, and default answer `electric`. Add an **If** action:
   - If the answer is `classic`, set a Text variable `bikeType` to `classic`.
   - Otherwise, set `bikeType` to `electric`.

   This makes e-bike the default. For an `any` request, change the If action to accept `any` as a third value.

4. Add a **Text** action with this value. Insert the latitude, longitude, and `bikeType` variables in the marked positions:

   ```text
   WORKER_URL/nearest?lat=LATITUDE&lon=LONGITUDE&type=BIKE_TYPE
   ```

5. Add **Get Contents of URL**. Set the method to `GET` and use the Text action as the URL. Set the action to continue in the Shortcut if it receives an error.
6. Add **Get Dictionary from Input**.
7. Add **Get Dictionary Value** for `selected`.
8. Add an **If** action: if `selected` is empty or has no value, get the dictionary value `message` and use **Speak Text**. Otherwise continue.
9. In the `Otherwise` branch, get these values from `selected`: `bikeType`, `name`, `availableCount`, `distanceMeters`, and `appleMapsWalkingUrl`.
10. Convert `distanceMeters` to feet with **Calculate**: multiply by `3.28084`, then round to the nearest whole number.
11. Map `bikeType` to spoken text: `electric` → `e-bike`; `classic` → `classic bike`.
12. Add an **If** action for the count. Use `bike` and `is` for a count of `1`; use `bikes` and `are` for all other counts. Add **Text** with this speech:

    ```text
    The nearest available [spoken bike type] is approximately [feet] feet away at [name]. [availableCount] [bike or bikes] [is or are] available.
    ```

13. Add **Speak Text** using the speech Text action. The Worker marks the distance as approximate because it is not a walking route distance.
14. Add **Choose from Menu** with prompt `Open walking directions?` and menu items `Yes` and `No`. In the `Yes` branch, use **Open URLs** with `appleMapsWalkingUrl`.

If the Worker returns a provider error, speak: `Bay Wheels data is temporarily unavailable. Try again in a moment.`
