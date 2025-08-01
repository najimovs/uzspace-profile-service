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

function getBatchPixelValues( filePath, coordinates ) {

	try {

		const coordString = coordinates.map( ( [ lon, lat ] ) => `${ lon } ${ lat }` ).join( "\n" )
		const result = execSync( `echo "${ coordString }" | gdallocationinfo -valonly -geoloc "${ filePath }"`, { encoding: "utf8" } )

		return result.trim().split( "\n" ).map( line => {
			const value = parseFloat( line.trim() )
			return isNaN( value ) ? null : value
		} )
	}
	catch ( error ) {

		return coordinates.map( () => null )
	}
}

function getPixelValue( filePath, lon, lat ) {

	return getBatchPixelValues( filePath, [ [ lon, lat ] ] )[ 0 ]
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

function haversineDistance( lon1, lat1, lon2, lat2 ) {

	const R = 6_371_000
	const dLat = ( lat2 - lat1 ) * Math.PI / 180
	const dLon = ( lon2 - lon1 ) * Math.PI / 180
	const lat1Rad = lat1 * Math.PI / 180
	const lat2Rad = lat2 * Math.PI / 180

	const a = Math.sin( dLat / 2 ) * Math.sin( dLat / 2 ) +
		Math.cos( lat1Rad ) * Math.cos( lat2Rad ) *
		Math.sin( dLon / 2 ) * Math.sin( dLon / 2 )

	const c = 2 * Math.atan2( Math.sqrt( a ), Math.sqrt( 1 - a ) )

	return R * c
}

app.post( "/profile", async ( req, res ) => {

	try {

		const { a, b, sampling_interval = 1, file_path = "data/1.tif" } = req.body

		if ( !a || !b || a.length !== 2 || b.length !== 2 ) {

			return res.status( 400 ).json( { error: "Two points required: a: [lon, lat], b: [lon, lat]" } )
		}

		const filePath = path.resolve( file_path )

		try {

			await fs.access( filePath )
		}
		catch {

			return res.status( 404 ).json( { error: "TIFF file not found" } )
		}

		const metadata = getGeoTiffMetadata( filePath )
		const geoTransform = metadata.geoTransform

		const [ x1, y1 ] = lonLatToPixel( a[ 0 ], a[ 1 ], geoTransform )
		const [ x2, y2 ] = lonLatToPixel( b[ 0 ], b[ 1 ], geoTransform )

		const pixelPoints = bresenhamLine( x1, y1, x2, y2, sampling_interval )

		const coordinates = pixelPoints.map( ( [ pixelX, pixelY ] ) => pixelToLonLat( pixelX, pixelY, geoTransform ) )
		const elevations = getBatchPixelValues( filePath, coordinates )

		const profile = []
		let distance = 0
		let prevLonLat = a

		for ( let i = 0; i < coordinates.length; i++ ) {

			const [ lon, lat ] = coordinates[ i ]
			const elevation = elevations[ i ]

			if ( profile.length > 0 ) {

				distance += haversineDistance( prevLonLat[ 0 ], prevLonLat[ 1 ], lon, lat )
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
