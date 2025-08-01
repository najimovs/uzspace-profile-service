import express from "express"
import { execSync } from "child_process"
import { promises as fs } from "fs"
import path from "path"

const app = express()
const PORT = process.env.PORT || 3_000

app.use( express.json() )

const metadataCache = new Map()

function getGeoTiffMetadata( filePath ) {

	if ( metadataCache.has( filePath ) ) {

		return metadataCache.get( filePath )
	}

	try {

		const result = execSync( `gdalinfo -json "${ filePath }"`, { encoding: "utf8" } )
		const metadata = JSON.parse( result )
		metadataCache.set( filePath, metadata )

		return metadata
	}
	catch ( error ) {

		throw new Error( `Failed to get metadata for ${ filePath }: ${ error.message }` )
	}
}

function getPixelValue( filePath, lon, lat ) {

	try {

		const result = execSync( `gdallocationinfo -valonly -geoloc "${ filePath }" ${ lon } ${ lat }`, { encoding: "utf8" } )
		const value = parseFloat( result.trim() )

		return isNaN(value) ? null : value
	}
	catch ( error ) {

		return null
	}
}

function bresenhamLine( x0, y0, x1, y1, samplingInterval = 1 ) {

	const points = []
	const dx = Math.abs( x1 - x0 )
	const dy = Math.abs( y1 - y0 )
	const sx = x0 < x1 ? 1 : -1
	const sy = y0 < y1 ? 1 : -1
	let err = dx - dy

	let x = x0;
	let y = y0;
	let stepCount = 0;

	while ( true ) {

		if ( stepCount % samplingInterval === 0 ) {

			points.push( [ x, y ] )
		}

		if ( x === x1 && y === y1 ) {

			break
		}

		const e2 = 2 * err

		if ( e2 > - dy ) {

			err -= dy
			x += sx
		}

		if ( e2 < dx ) {

			err += dx
			y += sy
		}

		stepCount++
	}

	return points
}

function lonLatToPixel( lon, lat, geoTransform ) {

	const [ originX, pixelWidth, , originY, , pixelHeight ] = geoTransform
	const pixelX = Math.round( ( lon - originX ) / pixelWidth )
	const pixelY = Math.round( ( lat - originY ) / pixelHeight )

	return [ pixelX, pixelY ]
}

function pixelToLonLat( pixelX, pixelY, geoTransform ) {

	const [ originX, pixelWidth, , originY, , pixelHeight ] = geoTransform
	const lon = originX + pixelX * pixelWidth
	const lat = originY + pixelY * pixelHeight

	return [ lon, lat ]
}

app.post( "/profile", async ( req, res ) => {

	try {

		const { points, sampling_interval = 1, tiff_file = "data/1.tif" } = req.body

		if ( !points || points.length !== 2 ) {

			return res.status( 400 ).json( { error: "Two points required: [[lon1, lat1], [lon2, lat2]]" } )
		}

		const filePath = path.resolve( tiff_file )

		try {

			await fs.access( filePath )
		} catch {

			return res.status( 404 ).json( { error: "TIFF file not found" } )
		}

		const metadata = getGeoTiffMetadata( filePath )
		const geoTransform = metadata.geoTransform

		const [ point1, point2 ] = points
		const [ x1, y1 ] = lonLatToPixel( point1[ 0 ], point1[ 1 ], geoTransform )
		const [ x2, y2 ] = lonLatToPixel( point2[ 0 ], point2[ 1 ], geoTransform )

		const pixelPoints = bresenhamLine( x1, y1, x2, y2, sampling_interval )

		const profile = []
		let distance = 0
		let prevLonLat = point1

		for ( const [ pixelX, pixelY ] of pixelPoints ) {

			const [ lon, lat ] = pixelToLonLat( pixelX, pixelY, geoTransform )
			const elevation = getPixelValue( filePath, lon, lat )

			if ( profile.length > 0 ) {

				const deltaLon = lon - prevLonLat[ 0 ]
				const deltaLat = lat - prevLonLat[ 1 ]
				distance += Math.sqrt( deltaLon * deltaLon + deltaLat * deltaLat ) * 111_320
			}

			profile.push( {
				distance: Math.round( distance * 100 ) / 100,
				elevation,
				coordinates: [ lon, lat ],
			} )

			prevLonLat = [ lon, lat ]
		}

		res.json( {
			profile,
			metadata: {
				totalPoints: profile.length,
				samplingInterval: sampling_interval,
				totalDistance: Math.round( distance * 100 ) / 100,
			}
		} )

	} catch ( error ) {

		console.error( "Profile generation error:", error )
		res.status( 500 ).json( { error: "Internal server error" } )
	}
} )

app.listen( PORT, () => {

	console.log( `Profile service running on port ${ PORT }` )
} )
